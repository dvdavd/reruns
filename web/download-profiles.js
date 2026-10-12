/* What a download profile is on this side of the wire, and the words the menu
   and the drawer put on one. The server owns the validation; these are the
   pure parts, so they can be read without a browser. */
import {plural, t} from './i18n.js';

export const PROFILE_OPTIONS = {
  media: 'video', quality: 'best', container: 'auto', codec: 'any', subtitles: 'none',
  subtitle_languages: 'en.*', audio_languages: '', comments: 'off', chat: 'off', playlist: 'all', organization: 'server',
  subdirectory: '', arguments: '',
};

/* Whether a download keeps a capped set of the video's comments beside it. Off
   unless asked: a busy thread adds seconds and a good deal of sidecar. */
export const commentChoices = () => [['off', t('profiles.comments.off')], ['on', t('profiles.comments.on')]];

/* Whether a download keeps a stream's chat replay beside it. Off unless asked:
   a long stream's chat is tens of megabytes, and most videos have none. */
export const chatChoices = () => [['off', t('profiles.chat.off')], ['on', t('profiles.chat.on')]];

export const BLANK_PROFILE = {id: '', name: '', library: '', options: {...PROFILE_OPTIONS}};

/* Which video codec to prefer. YouTube's best is usually AV1, which Safari
   plays only on a Mac with AV1 hardware; the server turns these into a sort,
   so a video offered in nothing else still downloads. Shared by the profile
   editor and the manual overrides. */
// A function rather than a list, since the words depend on the language chosen
// after this module has loaded.
export const codecChoices = () => [['any', t('profiles.codec.any')], ['vp9', t('profiles.codec.vp9')],
  ['h264', t('profiles.codec.h264')]];
const CODEC_LABELS = {vp9: 'VP9', h264: 'H.264'};
// What each preference fetches from YouTube, to ask a browser about.
const CODEC_PROBES = {
  vp9: 'video/webm; codecs="vp09.00.40.08"',
  h264: 'video/mp4; codecs="avc1.640028"',
};

/** The codec to fetch instead of one that will not play here, or null when
    this browser plays neither. `canPlay` is a video element's canPlayType. */
export function suggestedCodec(canPlay) {
  const codec = Object.keys(CODEC_PROBES).find(name => canPlay(CODEC_PROBES[name]) !== '');
  return codec ? {codec, name: CODEC_LABELS[codec]} : null;
}

// The container choices for each kind of media, shared by the profile editor and the manual overrides.
export const formatChoices = audio => audio
  ? [['auto', t('profiles.format.original')], ['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'Opus'], ['flac', 'FLAC']]
  : [['auto', t('profiles.format.auto')], ['mp4', 'MP4'], ['mkv', 'MKV'], ['webm', 'WebM']];

const mediaLabel = media => ({video: t('profiles.media.video'), audio: t('profiles.media.audio')})[media];
export const organisationChoices = () => [['server', t('profiles.organise.server')],
  ['creator', t('profiles.organise.creator')], ['playlist', t('profiles.organise.playlist')]];

export function profilesSummary(profiles) {
  if (!profiles.length) return t('profiles.none');
  return plural('count.profiles', profiles.length);
}

/** A profile's settings as one line, in the order someone reads them: what it
    fetches, how good, in what format, and where it lands. */
export function profileLabel(profile, libraries = []) {
  const options = {...PROFILE_OPTIONS, ...(profile.options || {})};
  const library = libraries.find(item => item.id === profile.library);
  const parts = [
    mediaLabel(options.media) || options.media,
    options.quality === 'best' ? t('profiles.bestQuality') : `${options.quality}p`,
    options.container === 'auto' ? '' : options.container.toUpperCase(),
    CODEC_LABELS[options.codec] || '',
    // The languages are worth a word only when there is something to fetch,
    // and only when they are not simply every language there is.
    options.subtitles === 'none' ? ''
      : `${t('profiles.subtitles')}${options.subtitle_languages ? ` (${options.subtitle_languages})` : ''}`,
    options.audio_languages ? t('profiles.audioLanguages.label', {languages: options.audio_languages.split(',').join(', ')}) : '',
    options.comments === 'on' ? t('profiles.comments') : '',
    options.chat === 'on' ? t('profiles.chat') : '',
    options.playlist === 'single' ? t('profiles.singleVideo') : '',
    organisationChoices().find(([value]) => value === options.organization)?.[1] || '',
    options.subdirectory,
    library ? library.path : '',
    options.arguments ? t('profiles.extraArguments') : '',
  ];
  // Audio has no resolution or video codec to speak of, so neither is worth a word.
  if (options.media === 'audio') { parts[1] = ''; parts[3] = ''; }
  return parts.filter(Boolean).join(' · ');
}

/** The menu the download arrow shows: the starred profile first, marked as
    the default, then the rest, then the manual overrides that were there
    before. The starred one is the empty choice, so it follows the star and
    lets a channel's own profile apply, as picking it by name would not. */
export function profileMenuItems(profiles, defaultProfile) {
  const starred = profiles.find(profile => profile.id === defaultProfile) || profiles[0];
  return [
    ...(starred ? [{value: '', label: starred.name, detail: t('profiles.default')}] : []),
    ...profiles.filter(profile => profile !== starred)
      .map(profile => ({value: profile.id, label: profile.name, detail: ''})),
    {value: 'manual', label: t('profiles.manual'), detail: ''},
  ];
}

/** Which menu entry is really selected. A profile deleted elsewhere, or in
    another tab, quietly gives the choice back to the default, and so does
    the starred one picked by id: that is the default by another name. */
export function resolveSelection(selection, profiles, defaultProfile = '') {
  if (selection === 'manual' || !selection) return selection || '';
  if (selection === defaultProfile) return '';
  return profiles.some(profile => profile.id === selection) ? selection : '';
}

/** The Browse panel's own choice: the same entries, without the manual
    overrides, which have no panel to show their selects in. */
export function browseProfileOptions(profiles, defaultProfile) {
  const items = profileMenuItems(profiles, defaultProfile).filter(item => item.value !== 'manual');
  return items.length
    ? items.map(item => ({value: item.value, label: item.label, detail: item.detail}))
    : [{value: '', label: t('profiles.default')}];
}

/** What POST /api/download is asked for: a profile by name, or the options
    the manual panel is showing, and a folder when this download is to go
    somewhere other than where the profile puts it. */
export function downloadBody(url, selection, readOptions, location = '') {
  const body = selection === 'manual'
    ? {url, options: readOptions()}
    : {url, profile: selection};
  return location ? {...body, location} : body;
}

/** The profile default or an explicit folder override. Labels stay compact;
    folder keys, rather than the displayed names, determine the destination. */
export function locationChoices(rows, selectedKey, defaultLabel = t('profiles.profileDefault')) {
  const current = rows.find(row => row.key === selectedKey);
  return [
    {value: '', label: defaultLabel},
    ...(current ? [{value: current.key, label: t('profiles.currentView', {name: current.name})}] : []),
    ...rows.map(row => ({value: row.key, label: row.name, depth: row.depth})),
  ];
}

/** Restricted accounts choose an explicit grant, including empty library folders
    that have no entries in the gallery yet. There is no profile-default option. */
export function grantedLocationChoices(grants, libraries) {
  return grants.flatMap(grant => {
    const library = libraries.find(item => item.id === grant.library);
    if (!library) return [];
    return [{value: JSON.stringify({library: grant.library, folder: grant.folder || ''}),
      label: (grant.folder || library.path).split('/').filter(Boolean).pop() || library.path}];
  });
}
