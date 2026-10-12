import {html, MediaRow, render} from 'media-ui';
import {icon} from './icon.js';
import {post, request} from './api.js';
import {loadChannelImage} from './channel-image.js';
import {createDrawerControls} from './drawer.js';
import {followButton} from './popover.js';
import {defaultMark} from './default-mark.js';
import {backlogFrom, choiceFor, intervalChoices, profileChoices, shortInterval,
  subscriptionProfileName}
  from './subscription-controls.js';
import {plural, t} from './i18n.js';

export {intervalChoices};

// A bare channel page (its own address, or one of its tabs) or a playlist
// (a "list=" address): the two kinds of link a check can actually follow.
// A lone video's listing never changes, so subscribing to one would just
// watch it forever without ever finding anything new; mirrors subscription_kind
// in subscriptions.py.
const CHANNEL_PAGE = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:@[^/?#]+|channel\/[\w-]+|c\/[^/?#]+|user\/[^/?#]+)(?:\/[^?#]*)?$/i;
export function subscribableKind(value) {
  const url = String(value || '').trim();
  return CHANNEL_PAGE.test(url) ? 'channel' : /[?&]list=/.test(url) ? 'playlist' : '';
}
export function isSubscribableUrl(value) {
  return Boolean(subscribableKind(value));
}

// The magnitude alone ("7 days"); relativeTime adds the in/ago direction.
export function shortDuration(seconds, now = Date.now() / 1000) {
  const minutes = Math.round(Math.abs(seconds - now) / 60);
  return minutes < 1 ? t('time.moments')
    : minutes < 90 ? t('time.minutes', {count: minutes})
      : minutes < 36 * 60 ? t('time.hours', {count: Math.round(minutes / 60)})
        : plural('time.days', Math.round(minutes / 1440));
}
export function relativeTime(seconds, now = Date.now() / 1000) {
  const phrase = shortDuration(seconds, now);
  return t(seconds - now >= 0 ? 'time.in' : 'time.ago', {phrase});
}

// Second line: state text while busy/broken, otherwise when it checks next.
export function subscriptionStatus(item, now = Date.now() / 1000) {
  if (item.state === 'seeding') return {text: t('subscriptions.listing'), clock: false, error: false};
  if (item.state === 'failed') return {text: t('subscriptions.listFailed', {error: item.error}), clock: false, error: true};
  if (item.checking && item.downloading) return {text: t('subscriptions.downloading'), clock: false, error: false};
  if (item.checking) return {text: t('subscriptions.checking'), clock: false, error: false};
  if (item.lastCheckFailed) return {text: t('subscriptions.checkFailed', {result: item.lastResult}), clock: false, error: true};
  if (!item.enabled) return {text: t('subscriptions.paused'), clock: true, error: false};
  if (!item.nextCheckAt) return {text: '', clock: false, error: false};
  return {
    text: item.nextCheckAt <= now ? t('subscriptions.soon') : shortDuration(item.nextCheckAt, now),
    clock: true, error: false,
  };
}

export function createSubscriptionsUI({form, urlInput, subscribeButton, readOptions, selection,
  isLink, reset, drawer, drawerClose, summary, list, intervalSelect, backlogSelect,
  onCheck, onBrowse, report}) {
  let timer = null;
  let items = [];
  let profiles = [];
  let defaultProfile = '';
  // Supplied once the gallery has loaded: the in-app link for a subscription.
  let linkFor = () => null;
  // Told apart from the drawer: the channel/playlist page, card menu and
  // watch page shortcuts all read the list through this, so they can offer
  // Unsubscribe once it already has their address.
  const listeners = new Set();
  function notify() { for (const fn of listeners) fn(items); }
  function onChange(fn) {
    listeners.add(fn);
    fn(items);
    return () => listeners.delete(fn);
  }
  // Pictures resolve once per subscription and redraw the list when they land.
  const images = new Map();
  const imageLookups = new Map();
  const fetchImage = id => request(`/api/subscription-image/${encodeURIComponent(id)}`);

  // Only channel and playlist links can be checked for new videos.
  function syncSubscribeButton() {
    const subscribable = isLink() && isSubscribableUrl(urlInput.value);
    subscribeButton.disabled = !subscribable;
    subscribeButton.hidden = !subscribable;
    subscribeButton.title = subscribable ? t('subscriptions.subscribeTitle') : t('subscriptions.pasteLink');
  }
  urlInput.addEventListener('input', syncSubscribeButton);
  urlInput.addEventListener('searchsync', syncSubscribeButton);
  syncSubscribeButton();

  async function act(path, body, failure) {
    try {
      await post(path, body);
      onCheck();
    } catch (error) {
      report(t('error.reason', {message: t(failure), reason: error.message || error}), {error: true});
    }
    refresh();
  }

  // Shared by the topbar's Subscribe button and the shortcuts on the channel
  // and playlist pages, the card menu, and the watch page: same request,
  // same defaults (the field's own options, and the topbar's own frequency
  // and backlog choice), just a different source for the URL. The browse
  // panel names its own profile, since it shows that choice beside the button.
  async function subscribeTo(url, {channelId = '', profile = null} = {}) {
    try {
      // Named and Default profiles are resolved again at each check. Manual
      // settings are saved as a snapshot. The server supplies the check
      // frequency and backlog defaults kept in this drawer.
      const chosen = profile ?? selection();
      const created = await post('/api/subscriptions', {
        url, channelId, ...(chosen === 'manual' ? {options: readOptions()} : {profile: chosen}),
      });
      report(created.state !== 'seeding' ? t('subscriptions.subscribed.now')
        : created.keep ? t('subscriptions.subscribed.latest', {count: created.keep})
          : t('subscriptions.subscribed.future'));
      onCheck();
      await refresh();
      return created;
    } catch (error) {
      report(t('error.reason', {message: t('subscriptions.error.subscribe'), reason: error.message || error}), {error: true});
      return null;
    }
  }

  /** The same Unsubscribe every shortcut offers once it already follows a
   *  channel or playlist, confirmed as the drawer's own delete asks. */
  async function unsubscribeFrom(id, label = t('subscriptions.this')) {
    if (!confirm(t('subscriptions.confirmUnsubscribe', {label}))) return false;
    try {
      await post(`/api/subscriptions/${id}/delete`, {});
      report(t('subscriptions.unsubscribed'));
      await refresh();
      return true;
    } catch (error) {
      report(t('error.reason', {message: t('subscriptions.error.unsubscribe'), reason: error.message || error}), {error: true});
      return false;
    }
  }

  subscribeButton.addEventListener('click', async () => {
    if (subscribeButton.disabled) return;
    if (await subscribeTo(urlInput.value.trim())) reset();
  });

  function imageFor(item) {
    if (!images.has(item.id)) {
      images.set(item.id, '');
      loadChannelImage(item.id, {cache: imageLookups, fetchState: fetchImage}).then(url => {
        if (!url) return;
        images.set(item.id, url);
        draw();
      });
    }
    return images.get(item.id);
  }

  // Not in the shared sprite, so drawn inline: a clock reading 4 o'clock.
  function clockIcon() {
    return html`<svg class="icon subscription-status-icon" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
      <path d="M12 12l3 2" />
      <path d="M12 7v5" />
    </svg>`;
  }

  /* The interval menu is a popover, so it sits above the drawer; it opens
     under its button, flipping above when there is no room below. */
  const followers = new WeakMap();
  function placeMenu(event) {
    const menu = event.currentTarget;
    const button = () => document.querySelector(`[popovertarget="${menu.id}"]`);
    const open = event.newState === 'open';
    button()?.setAttribute('aria-expanded', String(open));
    if (!followers.has(menu)) followers.set(menu, followButton(menu, button));
    if (open) followers.get(menu).start();
    else followers.get(menu).stop();
  }

  /* Two lines per source like the library folders: its picture (badged with
     a new-video count when the last check found any), then its name with a
     type chip and, below, a status line that's a short clock reading once
     there's nothing more urgent to say. */
  function row(item) {
    const label = item.title || item.url;
    const failed = item.state === 'failed';
    const busy = item.checking || item.state === 'seeding';
    const image = imageFor(item);
    const menuId = `subscription-interval-${item.id}`;
    const profileMenuId = `subscription-profile-${item.id}`;
    const selectedProfile = choiceFor(item.profileSelection ?? 'manual', defaultProfile);
    const profileName = subscriptionProfileName(item, profiles, defaultProfile);
    const link = linkFor(item);
    const kind = item.kind === 'channel' ? t('subscriptions.kind.channel') : item.kind === 'playlist' ? t('subscriptions.kind.playlist') : t('subscriptions.kind.feed');
    const status = subscriptionStatus(item);
    const badge = item.lastNewCount > 0 ? html`<span class="subscription-new-badge">
      ${item.lastNewCount > 99 ? '99+' : item.lastNewCount}</span>` : null;
    const actions = html`
        <button type="button" class="channel-profile-download-trigger subscription-profile-trigger"
          popovertarget=${profileMenuId} aria-haspopup="menu" aria-expanded="false"
          aria-label=${t('subscriptions.profileFor', {label, name: profileName})}
          title=${t('subscriptions.profileTitle', {name: profileName})}>
          ${icon('list-edit')}${icon('chevron-down')}
        </button>
        <div id=${profileMenuId} class="menu-popover download-profile-menu subscription-profile-menu"
          popover="auto" role="menu" aria-label=${t('subscriptions.profileMenu', {label})}
          onToggle=${placeMenu}>
          ${[...profileChoices(profiles, defaultProfile),
            {id: 'manual', name: t('subscriptions.currentSettings')}].map(profile => html`
            <button type="button" role="menuitemradio"
              aria-checked=${String(profile.id === selectedProfile)}
              onClick=${event => {
                event.currentTarget.closest('[popover]').hidePopover();
                if (profile.id !== selectedProfile) {
                  act(`/api/subscriptions/${item.id}/update`, profile.id === 'manual'
                    ? {profileSelection: 'manual'} : {profile: profile.id},
                  'subscriptions.error.profile');
                }
              }}><span>${profile.name}</span>
              ${profile.detail ? defaultMark() : null}</button>`)}
        </div>
        <button type="button" class="library-row-action subscription-interval"
          popovertarget=${menuId} aria-haspopup="menu" aria-expanded="false"
          aria-label=${t('subscriptions.frequencyFor', {label})} title=${t('subscriptions.frequency')}>
          ${shortInterval(item.interval)}</button>
        <div id=${menuId} class="menu-popover subscription-interval-menu" popover="auto" role="menu"
          onToggle=${placeMenu}>
          ${intervalChoices().map(([hours, text]) => html`<button type="button" role="menuitemradio"
            aria-checked=${String(hours === item.interval)}
            onClick=${event => {
              event.currentTarget.closest('[popover]').hidePopover();
              if (hours !== item.interval) {
                act(`/api/subscriptions/${item.id}/update`, {interval: hours}, 'subscriptions.error.frequency');
              }
            }}>${text}</button>`)}
        </div>
        ${onBrowse && item.kind ? html`<button type="button" class="library-row-action"
          aria-label=${t('subscriptions.browse', {label})} title=${t('subscriptions.browseTitle')}
          onClick=${() => onBrowse({kind: item.kind, url: item.url, title: item.title || ''},
            {over: {drawer, close}})}>${icon('search')}</button>` : null}
        <a class="library-row-action" href=${item.url} target="_blank" rel="noreferrer noopener"
          aria-label=${t('subscriptions.openOriginal')} title=${t('subscriptions.openOriginal')}>${icon('link')}</a>
        <button type="button" class="library-row-action" disabled=${busy}
          aria-label=${failed ? t('subscriptions.retry') : t('subscriptions.checkNow')} title=${failed ? t('subscriptions.retry') : t('subscriptions.checkNow')}
          onClick=${() => act(`/api/subscriptions/${item.id}/check`, {}, 'subscriptions.error.check')}>
          ${icon('refresh')}</button>
        <button type="button" class="library-row-action" role="switch" aria-checked=${String(!item.enabled)}
          aria-label=${item.enabled ? t('subscriptions.pause') : t('subscriptions.resume')} title=${item.enabled ? t('subscriptions.pause') : t('subscriptions.resume')}
          onClick=${() => act(`/api/subscriptions/${item.id}/update`,
            {enabled: !item.enabled}, 'subscriptions.error.update')}>
          ${icon(item.enabled ? 'pause' : 'play', 'is-solid')}</button>
        <button type="button" class="library-row-action danger" aria-label=${t('subscriptions.unsubscribe')} title=${t('subscriptions.unsubscribe')}
          onClick=${() => unsubscribeFrom(item.id, label)}>${icon('x')}</button>
    `;
    return html`<${MediaRow} key=${item.id} class="subscription-item" size="compact" lines=${1}
      round=${item.kind === 'channel'} data-kind=${item.kind || 'other'}
      data-paused=${String(!item.enabled)} thumbnail=${image} badge=${badge} actions=${actions}
      fallback=${icon(item.kind === 'channel' ? 'users' : item.kind === 'playlist' ? 'stack' : 'link')}>
      <p class="subscription-title-line">
        ${link ? html`<a class="subscription-title" href=${link.href} title=${t('subscriptions.show', {label})}
          onClick=${event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            close();
            link.open();
          }}>${label}</a>`
          : html`<span class="subscription-title" title=${item.url}>${label}</span>`}
        <span class="subscription-kind">${kind}</span>
      </p>
      <p class="media-row-meta subscription-detail" data-error=${String(status.error)} title=${status.text}>
        ${status.clock ? clockIcon() : null}<span>${status.text}</span></p>
    <//>`;
  }

  function draw() {
    summary.textContent = items.length
      ? plural('count.following', items.length)
      : t('subscriptions.none');
    // A heading over "nothing followed" would introduce nothing.
    list.parentElement.querySelector('h3').hidden = !items.length;
    render(items.length ? html`<ul class="library-list subscription-blocks">${items.map(row)}</ul>`
      : html`<p class="download-empty">${t('subscriptions.empty')}</p>`,
    list);
  }

  async function refresh() {
    clearTimeout(timer);
    try {
      items = await request('/api/subscriptions');
      draw();
      notify();
    } catch (error) {
      report(t('error.reason', {message: t('subscriptions.error.load'), reason: error.message || error}), {error: true});
    }
    if (drawer.open) timer = setTimeout(refresh, 5000);
  }

  /* The defaults a new subscription starts with. They live on the server
     beside the download profiles, so they hold across browsers and whatever
     else comes to follow a channel. */
  function setDefaults({subscriptionDefaults} = {}) {
    if (!subscriptionDefaults) return;
    intervalSelect.value = String(subscriptionDefaults.interval);
    const {backlog} = subscriptionDefaults;
    backlogSelect.value = backlog === true ? 'all' : backlog ? String(backlog) : 'new';
  }
  function setProfiles({downloadProfiles = [], defaultProfile: starred = ''} = {}) {
    profiles = downloadProfiles;
    defaultProfile = starred;
    draw();
  }
  async function saveDefaults() {
    try {
      setDefaults(await post('/api/settings/subscription-defaults', {
        interval: Number(intervalSelect.value),
        backlog: backlogFrom(backlogSelect.value),
      }));
    } catch (error) {
      report(t('error.reason', {message: t('subscriptions.error.defaults'), reason: error.message || error}),
        {error: true});
    }
  }
  intervalSelect.addEventListener('change', saveDefaults);
  backlogSelect.addEventListener('change', saveDefaults);

  const drawerControls = createDrawerControls(drawer);
  function open() {
    drawerControls.open();
    refresh();
  }
  function close() {
    clearTimeout(timer);
    drawerControls.close();
  }
  drawerClose.addEventListener('click', close);
  /** Wires the names to the gallery; the list redraws with the new links. */
  function setLinks(fn) {
    linkFor = fn;
    draw();
  }
  return {
    open, refresh, setLinks, setDefaults, setProfiles,
    subscribe: subscribeTo,
    unsubscribe: unsubscribeFrom,
    /** For the channel and playlist pages' own copies of the row's controls. */
    update: (id, changes, failure = 'subscriptions.error.update') =>
      act(`/api/subscriptions/${id}/update`, changes, failure),
    check: id => act(`/api/subscriptions/${id}/check`, {}, 'subscriptions.error.check'),
    list: () => items,
    onChange,
  };
}
