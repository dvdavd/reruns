// Codec names are names, the same in every language, so they are not in the
// catalogue. yt-dlp gives the codec string as the site does (avc1.64002A), or
// as the extractor shortens it (h264); either is matched by its prefix.
const VIDEO_CODECS = [['avc', 'H.264'], ['h264', 'H.264'], ['vp09', 'VP9'], ['vp9', 'VP9'],
  ['vp08', 'VP8'], ['vp8', 'VP8'], ['av01', 'AV1'], ['av1', 'AV1'],
  ['hvc1', 'H.265'], ['hev1', 'H.265'], ['h265', 'H.265'], ['hevc', 'H.265']];
const AUDIO_CODECS = [['mp4a', 'AAC'], ['aac', 'AAC'], ['opus', 'Opus'], ['vorbis', 'Vorbis'],
  ['mp3', 'MP3'], ['flac', 'FLAC'], ['ec-3', 'E-AC-3'], ['ac-3', 'AC-3']];

/* An unknown codec keeps its family and drops the profile after the first
   dot, which is the part only a decoder could read. */
function codecName(value, names) {
  const lower = String(value || '').toLowerCase();
  if (!lower || lower === 'none') return '';
  return names.find(([prefix]) => lower.startsWith(prefix))?.[1] || lower.split('.')[0];
}

export const videoCodecName = value => codecName(value, VIDEO_CODECS);
export const audioCodecName = value => codecName(value, AUDIO_CODECS);
