// A followed channel's or playlist's own settings, offered on its page beside
// Unsubscribe: how often it is checked, and a check now. The subscriptions
// drawer has the same controls per row; the words and the profile naming are
// shared from here so the two read alike.

import {anchorPopover} from './popover.js';
import {defaultMarkElement} from './default-mark.js';
import {t} from './i18n.js';

const HOURS = [1, 3, 6, 12, 24, 168];
// A function, since the words follow the language chosen after this loads.
export const intervalChoices = () => HOURS.map(hours => [hours, t(`interval.${hours}`)]);

/** The frequency as a pill says it: "6h" rather than "Every 6 hours". */
/** The backlog select's value as the server takes it: all, none, or a count. */
export function backlogFrom(value) {
  return value === 'all' ? true : value === 'new' ? false : Number(value);
}

export function shortInterval(hours) {
  if (!HOURS.includes(hours)) return '';
  return hours > 1 && hours < 24 ? t('interval.short', {hours}) : t(`interval.${hours}`);
}

/** The starred profile, which "Default" means wherever a menu offers it. */
export function starredProfile(profiles, defaultProfile) {
  return profiles.find(profile => profile.id === defaultProfile) || profiles[0];
}

/** The profiles a subscription's menu offers, the starred one first and marked,
    as the download arrow lists them. The empty id is "follow the default", so
    the starred profile is not offered a second time under its own id. */
export function profileChoices(profiles, defaultProfile) {
  const starred = starredProfile(profiles, defaultProfile);
  return [...(starred ? [{id: '', name: starred.name, detail: t('profiles.default')}] : [{id: '', name: t('profiles.default')}]),
    ...profiles.filter(profile => profile !== starred)];
}

/** Which menu row a stored selection ticks: one saved as the starred
    profile's own id reads as the default, since that is what it now is. */
export function choiceFor(selection, defaultProfile) {
  return selection === defaultProfile ? '' : selection;
}

/** What a subscription downloads with, by the name its menu gives it. */
export function subscriptionProfileName(item, profiles = [], defaultProfile = '') {
  const selection = item?.profileSelection ?? 'manual';
  if (selection === '') return starredProfile(profiles, defaultProfile)?.name || t('profiles.default');
  if (selection === 'manual') return t('subscriptions.currentSettings');
  return profiles.find(profile => profile.id === selection)?.name || t('subscriptions.savedSettings');
}

/**
 * A subscription whose own profile decides its downloads. One made with
 * Default follows the channel's profile instead; one from before channel
 * profiles existed has no say either way and keeps its own.
 */
export function subscriptionOwnsProfile(item) {
  return Boolean(item) && item.useChannelProfile !== true;
}

/** Fills a profile menu with radio rows, ticking `chosen`. */
export function fillProfileMenu(menu, options, chosen, onChoose) {
  menu.replaceChildren(...options.map(option => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(option.id === chosen));
    button.dataset.profile = option.id;
    const label = document.createElement('span');
    label.textContent = option.name;
    button.append(label);
    if (option.detail) {
      button.append(defaultMarkElement());
    }
    button.addEventListener('click', () => {
      menu.hidePopover();
      onChoose(option.id);
    });
    return button;
  }));
}

/**
 * Wires a frequency pill, its menu and a Check now button to whichever
 * subscription `update` is given, hiding all three when there is none.
 */
export function createSubscriptionControls({interval, intervalMenu, check, subscriptions}) {
  let current = null;
  anchorPopover(interval, intervalMenu);
  const rows = intervalChoices().map(([hours, text]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitemradio');
    button.textContent = text;
    button.addEventListener('click', () => {
      intervalMenu.hidePopover();
      if (current && hours !== current.interval) {
        subscriptions.update(current.id, {interval: hours}, 'subscriptions.error.frequency');
      }
    });
    return [hours, button];
  });
  intervalMenu.replaceChildren(...rows.map(([, button]) => button));
  check.addEventListener('click', () => {
    if (current) subscriptions.check(current.id);
  });

  return {
    update(subscription) {
      current = subscription || null;
      interval.hidden = check.hidden = !current;
      if (!current) {
        if (intervalMenu.matches(':popover-open')) intervalMenu.hidePopover();
        return;
      }
      interval.textContent = shortInterval(current.interval);
      interval.title = t('subscriptions.checkEvery', {interval: (intervalChoices()
        .find(([hours]) => hours === current.interval) || [0, ''])[1].toLowerCase()});
      for (const [hours, button] of rows) {
        button.setAttribute('aria-checked', String(hours === current.interval));
      }
      const failed = current.state === 'failed';
      check.disabled = Boolean(current.checking || current.state === 'seeding');
      check.title = failed ? t('subscriptions.retry') : t('subscriptions.checkNow');
      check.setAttribute('aria-label', check.title);
    },
  };
}
