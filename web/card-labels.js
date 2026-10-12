import {plural, t} from './i18n.js';

/**
 * What the shared video card says, in the chosen language. The card itself
 * only knows English defaults and asks its consumer for `labels`, so this is
 * where the app's words go in. `noun` is what a favourite is of: 'videos' on
 * the video cards, 'playlists' on the playlist cards.
 */
export function cardLabels({noun = 'videos', play = 'card.play', addPerson = 'card.addPerson'} = {}) {
  return {
    play: t(play), favourites: t(`card.noun.${noun}`), addPerson: t(addPerson),
    playbackProgress: t('card.playbackProgress'), details: t('card.details'),
    viewDetails: values => t('card.viewDetails', values),
    addTo: values => t('card.addTo', values), removeFrom: values => t('card.removeFrom', values),
    videoParts: t('card.videoParts'), previousPart: t('card.previousPart'), nextPart: t('card.nextPart'),
    part: values => t('card.part', values), remastered: t('card.remastered'),
    audioOnly: t('item.audioOnly'),
    showVideosBy: values => t('card.showVideosBy', values), actionsFor: values => t('card.actionsFor', values),
    inPlaylists: values => plural('count.inPlaylists', values.count),
    showPlaylists: values => t('card.showPlaylists', values),
    playlistsChip: values => plural('count.playlistsChip', values.count),
    showVideosIn: values => t('card.showVideosIn', values),
    filterBy: values => t('card.filterBy', values), toggleFavourite: values => t('card.toggleFavourite', values),
  };
}
