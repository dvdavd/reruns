/* Made-up downloads for styling the queue drawer without running yt-dlp.
   Loading the page with ?debugdownload=1 swaps them in for the server's jobs.
   The running ones advance with the clock, so the bars and badge move. */
export const DEBUG_DOWNLOADS = new URLSearchParams(location.search).has('debugdownload');

const started = Date.now();

function transfer(percent, speed, eta, state = 'running') {
  return {state, percent, speed, eta};
}

function item(id, title, state, extra = {}) {
  return {
    id, videoId: id, title, webpageUrl: '', playlistIndex: null, playlistCount: null,
    state, channel: 'Example Channel', channelId: '', thumbnail: '', duration: 754,
    error: '', files: [], transfers: [], ...extra,
  };
}

function job(id, title, state, items, extra = {}) {
  return {
    id, url: `https://www.youtube.com/watch?v=${id}`, state, subscriptionId: '', error: '',
    options: {}, title, channel: 'Example Channel', thumbnail: '', createdAt: started / 1000,
    finishedAt: null, counts: {total: items.length, completed: 0, failed: 0}, items, ...extra,
  };
}

export function debugJobs() {
  const seconds = (Date.now() - started) / 1000;
  // Loops every 40s so there is always something in flight.
  const video = (seconds * 2.5) % 100;
  const audio = Math.min(100, video * 1.6);
  return [
    job('dbgsingle', 'A single video', 'running', [
      item('dbgsingle', 'Building a tiny cabin in the woods, start to finish', 'running', {
        duration: 2710,
        format: {id: '299+258', vcodec: 'avc1.64002A', acodec: 'mp4a.40.2', height: 1080, fps: 60,
          warnings: [{level: 'note', code: 'codecLimit', wanted: 'H.264', got: 1080, available: 2160}]},
        transfers: [transfer(video, '4.2MiB/s', `00:${String(Math.round((100 - video) / 2.5)).padStart(2, '0')}`),
          transfer(audio, '', '', audio >= 100 ? 'done' : 'running')],
      }),
    ]),
    job('dbgplaylist', 'A playlist', 'running', [
      item('dbgp1', 'Episode one: the beginning', 'done', {
        playlistIndex: 1, playlistCount: 4, files: ['Example Channel/Episode one.mp4'],
      }),
      item('dbgp2', 'Episode two: a much longer title that should wrap or truncate somewhere sensible in the row', 'postprocessing', {
        playlistIndex: 2, playlistCount: 4, transfers: [transfer(100, '', '', 'done')],
      }),
      item('dbgp3', 'Episode three', 'queued', {playlistIndex: 3, playlistCount: 4}),
      item('dbgp4', 'Episode four', 'queued', {playlistIndex: 4, playlistCount: 4}),
    ]),
    job('dbginspect', '', 'inspecting', [], {url: 'https://www.youtube.com/@examplechannel/videos'}),
    job('dbgpaused', 'Paused video', 'paused', [
      item('dbgpaused', 'Paused halfway through', 'paused', {
        transfers: [transfer(48, '', '', 'paused')],
      }),
    ]),
    job('dbgfailed', 'Failed video', 'failed', [
      item('dbgfailed', 'This one did not work', 'failed', {
        error: 'ERROR: [youtube] dbgfailed: Video unavailable. This video is private',
      }),
    ]),
    job('dbgcancel', 'Cancelled video', 'cancelled', [
      item('dbgcancel', 'Cancelled before it finished', 'cancelled', {transfers: [transfer(12, '', '', 'cancelled')]}),
    ]),
    job('dbgdone', 'Finished video', 'done', [
      item('dbgdone', 'Already downloaded and in the archive', 'done', {
        files: ['Example Channel/Already downloaded and in the archive.mkv'],
        format: {id: '18', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, fps: 30,
          warnings: [{level: 'warning', code: 'smaller', got: 360, available: 1080}]},
      }),
    ]),
  ];
}
