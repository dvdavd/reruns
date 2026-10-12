import test from 'node:test';
import assert from 'node:assert/strict';
import {aboutRows, updateStatus} from '../web/about-ui.js';

test('lists the app then each tool, keeping a missing one as null', () => {
  assert.deepEqual(aboutRows({version: '1', pyav: null, ffmpeg: '7', ytdlp: '2026'}),
    [['Reruns', '1'], ['PyAV', null], ['ffmpeg', '7'], ['yt-dlp', '2026']]);
});

test('says nothing about updates until a check has run', () => {
  assert.deepEqual(updateStatus({state: 'idle', checkedAt: null}), {text: 'Not checked yet', error: false});
});

test('reports an up-to-date copy and when it was checked', () => {
  const status = updateStatus({state: 'idle', version: '2026.02.01', latest: '2026.02.01',
    checkedAt: 1000 - 3 * 3600}, 1000);
  assert.deepEqual(status, {text: 'Up to date · checked 3 h ago', error: false});
});

test('names a release it could not install, and why', () => {
  assert.deepEqual(updateStatus({state: 'error', error: 'no network'}),
    {text: 'Update failed: no network', error: true});
  assert.equal(updateStatus({state: 'updating', latest: '2026.03.01'}).text, 'Installing 2026.03.01…');
});
