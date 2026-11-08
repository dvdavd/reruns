import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {ACTIVE_STATES, createJobFailureTracker} from '../web/download-model.js';
import {t} from '../web/i18n.js';

const source = readFileSync(new URL('../web/downloads-ui.js', import.meta.url), 'utf8');
const poll = source.slice(source.indexOf('  async function poll() {'),
  source.indexOf("  form.addEventListener('submit'"));

for (const scenario of ['failed only', 'partial playlist', 'active playlist', 'scan failure']) {
  test(`subtitle failure and archive refresh: ${scenario}`, async () => {
    const failed = {id: 'sub', kind: 'subtitles', state: 'failed', title: 'Clip',
      error: 'HTTP Error 429: Too Many Requests'};
    const jobs = [failed];
    if (scenario !== 'failed only') jobs.push({id: 'playlist',
      state: scenario === 'active playlist' ? 'running' : 'failed', counts: {completed: 1}});
    const newFailures = createJobFailureTracker();
    newFailures([{...failed, state: 'running'}, ...jobs.slice(1)]);
    const messages = [];
    const context = vm.createContext({
      DEBUG_DOWNLOADS: false, jobFeed: {read: async () => jobs}, draw() {}, newFailures, t,
      onJobs: () => false, ACTIVE_STATES, completedBefore: 0, arrivalWaiting: false, lastArrivalReload: 0, ARRIVAL_RELOAD_MS: 15000,
      pollFailures: 0, pollTimer: null, POLL_FAILURES_BEFORE_REPORT: 3,
      setTimeout: () => 1, clearTimeout() {},
      report: (message, options) => messages.push({message, options}),
      onSettled: async () => {
        messages.push({message: 'Scanning archive…'});
        if (scenario === 'scan failure') throw new Error('Scan failed');
        messages.push({message: ''});
      },
    });
    await vm.runInContext(`${poll}\npoll()`, context);
    const last = messages.at(-1);
    assert.match(last.message, /Subtitle download failed.*Clip.*HTTP Error 429/);
    assert.equal(last.options.error, true);
    assert.equal(last.options.timeout, 10000);
    assert.equal(messages.filter(entry => entry.options?.error).length, 1);
    assert.equal(messages.some(entry => entry.message === 'Scanning archive…'), scenario !== 'failed only');
  });
}

test('a successful job completed before the next poll refreshes the archive once', async () => {
  let scans = 0;
  const context = vm.createContext({
    DEBUG_DOWNLOADS: false, t,
    jobFeed: {read: async () => [{id: 'fast', state: 'done', counts: {completed: 1}}]},
    draw() {}, newFailures: createJobFailureTracker(), onJobs: () => false,
    ACTIVE_STATES, completedBefore: 0, arrivalWaiting: false, lastArrivalReload: 0, ARRIVAL_RELOAD_MS: 15000, pollFailures: 0, pollTimer: null,
    POLL_FAILURES_BEFORE_REPORT: 3, setTimeout: () => 1, clearTimeout() {},
    report() {}, onSettled: async () => { scans++; },
  });
  await vm.runInContext(`${poll}\npoll()`, context);
  await vm.runInContext('poll()', context);
  assert.equal(scans, 1);
});

test('a comments-only refresh does not read the library again', async () => {
  let scans = 0;
  const context = vm.createContext({
    DEBUG_DOWNLOADS: false, t,
    jobFeed: {read: async () => [{id: 'talk', kind: 'refresh', commentsOnly: true, state: 'done', counts: {completed: 1}}]},
    draw() {}, newFailures: createJobFailureTracker(), onJobs: () => false,
    ACTIVE_STATES, completedBefore: 0, arrivalWaiting: false, lastArrivalReload: 0, ARRIVAL_RELOAD_MS: 15000, pollFailures: 0, pollTimer: null,
    POLL_FAILURES_BEFORE_REPORT: 3, setTimeout: () => 1, clearTimeout() {},
    report() {}, onSettled: async () => { scans++; },
  });
  await vm.runInContext(`${poll}\npoll()`, context);
  assert.equal(scans, 0);
});

test('parts landing during a long job reload the gallery at most every 15 seconds, and once more at the end', async () => {
  let scans = 0;
  let clock = 100000;
  let jobs = [];
  const context = vm.createContext({
    DEBUG_DOWNLOADS: false, t, Date: {now: () => clock},
    jobFeed: {read: async () => jobs},
    draw() {}, newFailures: createJobFailureTracker(), onJobs: () => false,
    ACTIVE_STATES, completedBefore: null, arrivalWaiting: false, lastArrivalReload: 0,
    ARRIVAL_RELOAD_MS: 15000, pollFailures: 0, pollTimer: null,
    POLL_FAILURES_BEFORE_REPORT: 3, setTimeout: () => 1, clearTimeout() {},
    report() {}, onSettled: async () => { scans++; },
  });
  const at = async (seconds, completed, state = 'running') => {
    clock = 100000 + seconds * 1000;
    jobs = [{id: 'list', state, counts: {completed}}];
    await vm.runInContext('poll()', context);
  };
  await vm.runInContext(poll, context);
  await at(0, 0);
  await at(1, 1);
  assert.equal(scans, 1, 'the first part shows straight away');
  await at(5, 2);
  await at(10, 3);
  assert.equal(scans, 1, 'later parts wait');
  await at(16, 3);
  assert.equal(scans, 2, 'and are shown once the wait is up');
  await at(18, 4);
  await at(19, 4, 'done');
  assert.equal(scans, 3, 'the end of the job shows what was still waiting');
});
