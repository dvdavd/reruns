import test from 'node:test';
import assert from 'node:assert/strict';
import {activitySummary, activityText, dayLabel, entryTime, filterActivity, mergeActivity, sourceLabel}
  from '../web/activity-ui.js';

const entry = (id, source, level = 'info', extra = {}) => ({
  id, at: 1_790_000_000 + id, level, source, message: `line ${id}`, detail: '', ...extra,
});

test('a poll adds what came after the last entry held', () => {
  const held = {boot: 'a', latest: 2, entries: [entry(1, 'download'), entry(2, 'download')]};
  const next = mergeActivity(held, {boot: 'a', latest: 3, entries: [entry(3, 'portrait')]});
  assert.deepEqual(next.entries.map(found => found.id), [1, 2, 3]);
  assert.equal(next.latest, 3);
});

test('a restarted server replaces what was held, since it numbers from one again', () => {
  const held = {boot: 'a', latest: 40, entries: [entry(40, 'download')]};
  const next = mergeActivity(held, {boot: 'b', latest: 1, entries: [entry(1, 'server')]});
  assert.deepEqual(next, {boot: 'b', latest: 1, entries: [entry(1, 'server')]});
});

test('only the latest are kept', () => {
  const next = mergeActivity({boot: '', latest: 0, entries: []},
    {boot: 'a', latest: 5, entries: [1, 2, 3, 4, 5].map(id => entry(id, 'download'))}, 3);
  assert.deepEqual(next.entries.map(found => found.id), [3, 4, 5]);
});

test('filters by kind of work, with the rest under one choice, and by level', () => {
  const entries = [entry(1, 'download'), entry(2, 'subtitles', 'warning'),
    entry(3, 'sponsorblock', 'error'), entry(4, 'yt-dlp')];
  const ids = options => filterActivity(entries, options).map(found => found.id);
  assert.deepEqual(ids({}), [1, 2, 3, 4]);
  assert.deepEqual(ids({source: 'subtitles'}), [2]);
  assert.deepEqual(ids({source: 'other'}), [3, 4]);
  assert.deepEqual(ids({level: 'problems'}), [2, 3]);
  assert.deepEqual(ids({level: 'errors'}), [3]);
  assert.deepEqual(ids({source: 'other', level: 'errors'}), [3]);
});

test('the summary counts entries and names any problems', () => {
  assert.equal(activitySummary([]), 'Nothing yet');
  assert.equal(activitySummary([entry(1, 'download')]), '1 entry');
  assert.equal(activitySummary([entry(1, 'download'), entry(2, 'download', 'error'),
    entry(3, 'portrait', 'warning'), entry(4, 'portrait', 'warning')]),
  '4 entries · 1 error · 2 warnings');
});

test('copies as a log file reads, with any detail indented under its line', () => {
  const text = activityText([entry(1, 'subtitles', 'warning', {detail: 'first\nsecond'})]);
  const [line, ...detail] = text.split('\n');
  assert.match(line, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}WARNING {2}Subtitles: line 1$/);
  assert.deepEqual(detail, ['    first', '    second']);
});

test('rows give the time alone, and a heading names the day', () => {
  const now = new Date(2026, 8, 28, 15, 0, 0);
  const at = (day, hour = 9) => new Date(2026, 8, day, hour, 5, 7) / 1000;
  assert.equal(entryTime(at(26)), '09:05:07');
  assert.equal(dayLabel(at(28), now), 'Today');
  assert.equal(dayLabel(at(27), now), 'Yesterday');
  assert.match(dayLabel(at(25), now), /25/);
});

test('names each kind of work for people, passing unknown ones through', () => {
  assert.equal(sourceLabel('portrait'), 'Portrait');
  assert.equal(sourceLabel('something-new'), 'something-new');
});
