// Which of a video's downloaded copies to play on this device. The gallery
// ranks copies by picture and size (groupFormats), which says nothing about
// whether this browser decodes them: Safari on a Mac with no AV1 hardware
// loads an AV1 file and never plays it, while a VP9 copy of the same video
// sits unused in the format chooser. So before a video opens, its copies are
// put to the browser best first, and the first it says it can decode plays.

import {codecNameOf, currentFormat} from './item-adapter.js';
import {preferences} from './preferences.js';
import {suggestedCodec} from './download-profiles.js';

export const PREFERRED_CODEC_KEY = 'archive-preferred-codec';

/**
 * Asks the browser whether it decodes an encoding: canPlayType first, which
 * is quick and rules out what it has never heard of, then MediaCapabilities,
 * which knows about hardware. Null when there is nothing to ask about or the
 * browser cannot judge it, which counts as playable: a wrong no would hide a
 * copy that plays, where a wrong yes only costs the message it costs today.
 */
async function askDecodable(encoding, probe) {
  if (!encoding?.contentType) return null;
  if (probe.canPlayType && probe.canPlayType(encoding.contentType) === '') return false;
  if (!probe.decodingInfo) return null;
  const {name, ...video} = encoding;
  try { return Boolean((await probe.decodingInfo({type: 'file', video})).supported); }
  catch { return null; }
}

const keyOf = encoding => encoding?.contentType
  ? [encoding.contentType, encoding.width, encoding.height, encoding.framerate].join('|') : '';

/**
 * The browser's answers, kept for the session (a device does not gain or lose
 * a decoder while the page is open), so reopening a video, and drawing the
 * chooser, ask nothing twice.
 */
export function createFormatChooser({
  probe = defaultProbe(),
  store = preferences,
} = {}) {
  const answers = new Map();
  // Videos whose copy the viewer picked themselves this session: the choice
  // stands, even over a higher copy of the codec they prefer.
  const picked = new Set();

  function decodable(encoding) {
    const key = keyOf(encoding);
    if (!key) return Promise.resolve(null);
    if (!answers.has(key)) answers.set(key, askDecodable(encoding, probe).then(answer => {
      answers.set(key, answer);
      return answer;
    }));
    return Promise.resolve(answers.get(key));
  }

  /** What is already known, without asking: false only for a copy the
   *  browser has said no to. For the chooser, which draws synchronously. */
  function refused(format) {
    const answer = answers.get(keyOf(format.encoding));
    return answer === false;
  }

  function preferredCodec() {
    try { return store.getItem(PREFERRED_CODEC_KEY) || ''; } catch { return ''; }
  }

  /**
   * The id of the copy to play, or the current one when nothing better is
   * known. Only copies with a picture are candidates: the sound alone is a
   * copy someone chose to keep, not a stand-in for the video.
   */
  async function choose(item) {
    const current = currentFormat(item);
    if (!current) return item?.id;
    const formats = item.archive.formats;
    const verdicts = await Promise.all(formats.map(format => decodable(format.encoding)));
    if (picked.has(item.id)) return current.id;
    const playable = formats.filter((format, index) => !format.audioOnly && verdicts[index] !== false);
    if (!playable.length) return current.id;
    const preferred = preferredCodec();
    return (preferred && playable.find(format => codecNameOf(format) === preferred) || playable[0]).id;
  }

  /** The viewer chose a copy: it stands for this video, and its codec is the
   *  one this device prefers from now on. */
  function remember(item, format) {
    picked.add(item.id);
    const codec = codecNameOf(format);
    if (!codec || format.audioOnly) return;
    try { store.setItem(PREFERRED_CODEC_KEY, codec); } catch { /* A blocked store only loses the preference. */ }
  }

  /** A codec worth downloading for a video none of whose copies plays here
   *  ({codec, name}), or null when this browser decodes nothing offered. */
  async function suggest(item) {
    const copies = item?.archive?.formats?.length ? item.archive.formats : [item?.parts?.[0]].filter(Boolean);
    const verdicts = await Promise.all(copies.map(copy => decodable(copy.encoding)));
    const held = copies.filter((copy, index) => verdicts[index] === false).map(codecNameOf);
    return suggestedCodec(decodable, held);
  }

  return {choose, decodable, refused, remember, suggest};
}

function defaultProbe() {
  const video = globalThis.document?.createElement('video');
  const capabilities = globalThis.navigator?.mediaCapabilities;
  return {
    canPlayType: video ? type => video.canPlayType(type) : null,
    decodingInfo: capabilities ? config => capabilities.decodingInfo(config) : null,
  };
}
