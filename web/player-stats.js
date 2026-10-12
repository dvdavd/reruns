// A panel of what the player knows about the copy it is playing, over the
// picture, for working out why a video stutters, looks soft or will not seek.
// It reads the video element and the provider's source rather than keeping
// any state of its own, so what it shows is what playback is actually doing.
import {formatBytes} from 'media-ui';
import {t} from './i18n.js';

const READY_STATES = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
const NETWORK_STATES = ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'];

const seconds = value => Number.isFinite(value) ? `${value.toFixed(2)}s` : '–';
const size = (width, height) => width && height ? `${width}×${height}` : '–';
const bitrate = bits => bits >= 1e6 ? `${(bits / 1e6).toFixed(2)} Mbps`
  : bits > 0 ? `${Math.round(bits / 1e3)} kbps` : '';

function ranges(timeRanges) {
  const list = [];
  for (let index = 0; index < (timeRanges?.length || 0); index++) {
    list.push(`${timeRanges.start(index).toFixed(1)}–${timeRanges.end(index).toFixed(1)}`);
  }
  return list;
}

/** How far the buffer runs past the playhead, or zero if it is not in one. */
export function bufferAhead(timeRanges, time) {
  for (let index = 0; index < (timeRanges?.length || 0); index++) {
    if (timeRanges.start(index) <= time + .1 && timeRanges.end(index) >= time) {
      return Math.max(0, timeRanges.end(index) - time);
    }
  }
  return 0;
}

/**
 * The rows the panel shows, as [label, value] pairs, from a plain snapshot so
 * the wording can be tested without a video element. A fact the snapshot has
 * no answer for is left out rather than shown blank.
 */
export function statsRows({item, partIndex = 0, source, video, viewport, connection}) {
  const part = item?.parts?.[partIndex] || item?.parts?.[0] || {};
  const encoding = part.encoding || {};
  const archive = item?.archive || {};
  const rows = [];
  const add = (label, value) => { if (value) rows.push([label, value]); };

  add(t('stats.source'), archive.sourceId && [archive.extractor, archive.sourceId].filter(Boolean).join(':'));
  add(t('stats.key'), archive.formatId || item?.id);
  add(t('stats.file'), part.filename);
  add(t('stats.fileSize'), part.sizeBytes ? formatBytes(part.sizeBytes) : '');
  const remux = source?.remux;
  add(t('stats.delivery'), remux ? t('stats.deliveryRemux', {mime: remux.mime}) : source ? t('stats.deliveryNative') : '');
  add(t('stats.container'), archive.container && archive.container.toUpperCase());
  add(t('stats.videoCodec'), [encoding.name, part.codec].filter(Boolean).join(' · '));
  add(t('stats.audioCodec'), archive.audioCodec);
  add(t('stats.encoded'), [size(encoding.width, encoding.height),
    encoding.framerate || archive.fps ? `${encoding.framerate || archive.fps} fps` : '',
    bitrate(encoding.bitrate)].filter(value => value && value !== '–').join(' · '));
  if (video) {
    add(t('stats.decoded'), size(video.videoWidth, video.videoHeight));
    add(t('stats.viewport'), viewport
      ? `${size(Math.round(viewport.width), Math.round(viewport.height))} @ ${viewport.pixelRatio}x` : '');
    const quality = video.quality;
    add(t('stats.frames'), quality && quality.totalVideoFrames
      ? t('stats.framesValue', {dropped: quality.droppedVideoFrames, total: quality.totalVideoFrames}) : '');
    add(t('stats.position'), `${seconds(video.currentTime + (source?.startOffset || 0))} / ${seconds(source?.durationSeconds || video.duration)}`);
    add(t('stats.speed'), `${video.playbackRate}x`);
    add(t('stats.bufferHealth'), seconds(bufferAhead(video.buffered, video.currentTime)));
    add(t('stats.buffered'), ranges(video.buffered).join(', ') || '–');
    add(t('stats.state'), [READY_STATES[video.readyState], NETWORK_STATES[video.networkState],
      video.paused ? t('stats.paused') : t('stats.playing'), video.seeking ? t('stats.seeking') : '',
      video.ended ? t('stats.ended') : ''].filter(Boolean).join(' · '));
    add(t('stats.volume'), video.muted ? t('stats.muted') : `${Math.round(video.volume * 100)}%`);
    add(t('stats.subtitles'), video.subtitles);
    if (video.error) add(t('stats.error'), `${video.error.code}${video.error.message ? ` ${video.error.message}` : ''}`);
  }
  const stream = source?.remuxPlayback;
  if (stream) {
    add(t('stats.remux'), [stream.streamFrom === null || stream.streamFrom === undefined
      ? t('stats.remuxIdle') : t('stats.remuxFrom', {from: seconds(stream.streamFrom)}),
    t('stats.remuxTo', {to: seconds(stream.appendedTo)}),
    stream.awaitingTarget ? t('stats.remuxSeeking', {target: seconds(stream.target)}) : '',
    stream.media?.readyState].filter(Boolean).join(' · '));
  }
  if (connection) {
    add(t('stats.connection'), [connection.effectiveType,
      connection.downlink ? `${connection.downlink} Mbps` : '',
      Number.isFinite(connection.rtt) ? `${connection.rtt} ms` : ''].filter(Boolean).join(' · '));
  }
  return rows;
}

/**
 * Puts the panel on the player and keeps it current while it is shown. It
 * redraws on a timer, not on media events: dropped frames and the buffer
 * change without any event saying so.
 */
export function createPlayerStats(element, mediaPlayer, {onClose} = {}) {
  const panel = document.createElement('div');
  panel.className = 'archive-player-stats';
  panel.hidden = true;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'archive-player-stats-close';
  close.setAttribute('aria-label', t('stats.close'));
  close.title = t('stats.close');
  close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>';
  close.addEventListener('click', () => onClose?.());
  const list = document.createElement('dl');
  panel.append(close, list);
  // The player treats a click on its picture as play/pause; selecting a row
  // to copy it should not pause the video under it.
  for (const type of ['click', 'dblclick', 'pointerdown']) {
    panel.addEventListener(type, event => event.stopPropagation());
  }
  element.append(panel);

  let timer = null;
  function snapshot() {
    const {video} = mediaPlayer;
    const showing = [...(video.textTracks || [])].find(track => track.mode === 'showing');
    return {
      item: mediaPlayer.item,
      partIndex: mediaPlayer.partIndex,
      source: mediaPlayer.source,
      video: {
        currentTime: video.currentTime, duration: video.duration, playbackRate: video.playbackRate,
        videoWidth: video.videoWidth, videoHeight: video.videoHeight, buffered: video.buffered,
        readyState: video.readyState, networkState: video.networkState, paused: video.paused,
        seeking: video.seeking, ended: video.ended, muted: video.muted, volume: video.volume,
        error: video.error, quality: video.getVideoPlaybackQuality?.(),
        subtitles: showing ? showing.language || showing.label : '',
      },
      viewport: {width: video.clientWidth, height: video.clientHeight, pixelRatio: window.devicePixelRatio || 1},
      connection: navigator.connection,
    };
  }
  // Rows are kept and only their changed values rewritten, so a value the
  // viewer has selected to copy is not unselected every half second.
  function draw() {
    const rows = statsRows(snapshot());
    if (rows.map(([label]) => label).join('\n') !== [...list.children].map(row => row.firstChild.textContent).join('\n')) {
      list.replaceChildren(...rows.map(([label]) => {
        const row = document.createElement('div');
        const term = document.createElement('dt');
        term.textContent = label;
        row.append(term, document.createElement('dd'));
        return row;
      }));
    }
    rows.forEach(([, value], index) => {
      const definition = list.children[index].lastChild;
      if (definition.textContent !== value) definition.textContent = value;
    });
  }
  return {
    show(shown) {
      panel.hidden = !shown;
      clearInterval(timer);
      timer = null;
      if (!shown) return;
      draw();
      timer = setInterval(draw, 500);
    },
  };
}
