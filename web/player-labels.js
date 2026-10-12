import {t} from './i18n.js';

/** What the shared player says, in the chosen language: the package only has
 *  English defaults and asks its app for `labels` (see DEFAULT_PLAYER_LABELS). */
export function playerLabels() {
  return {
    player: t('ui.player'), canvas: t('ui.canvas'), audioOnly: t('ui.audioOnly'), controls: t('ui.controls'),
    play: t('ui.play'), pause: t('ui.pause'), restart: t('ui.restart'), seek: t('ui.seek'),
    mute: t('ui.mute'), unmute: t('ui.unmute'), volume: t('ui.volume'),
    showRaw: t('ui.showRaw'), showUnwarped: t('ui.showUnwarped'), resetView: t('ui.resetView'),
    enterFullscreen: t('ui.enterFullscreen'), exitFullscreen: t('ui.exitFullscreen'),
    cannotPlay: t('ui.cannotPlay'), cannotPlayEncoding: values => t('ui.cannotPlayEncoding', values),
    couldNotLoad: t('ui.couldNotLoad'), seeking: t('ui.seeking'), couldNotSeek: t('ui.couldNotSeek'), noWebgl: t('ui.noWebgl'),
  };
}
