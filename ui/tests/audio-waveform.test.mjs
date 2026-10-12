import assert from 'node:assert/strict';
import test from 'node:test';

import {AudioWaveform} from '../shared/components/AudioWaveform.js';

test('the waveform reads live samples while keeping audio connected to output', async () => {
  const connections = [];
  let created = 0;
  const context = {
    state: 'running', destination: {name: 'speakers'},
    createMediaElementSource() {
      created++;
      return {connect: node => connections.push(node)};
    },
    createAnalyser() {
      return {fftSize: 0, getByteTimeDomainData(data) {
        data.fill(128);
        data.fill(200, 0, 40);
      }};
    },
  };
  const bars = Array.from({length: 13}, () => ({style: {height: ''}}));
  const video = {src: '/audio.mp3', paused: false, muted: false, volume: 1};
  let active = true;
  let cancelled = 0;
  const wave = new AudioWaveform(video, bars, () => active, {
    Context: class { constructor() { return context; } }, origin: 'http://localhost',
    requestFrame: () => 1, cancelFrame: () => { cancelled++; },
  });
  await wave.start();
  assert.equal(created, 1);
  assert.equal(connections[0], context.destination);
  assert.equal(connections.length, 2, 'the analyser is a parallel branch');
  assert.ok(parseFloat(bars[0].style.height) > 3);
  assert.equal(parseFloat(bars.at(-1).style.height), 3);

  wave.pause();
  assert.equal(cancelled, 1);
  active = false;
  video.paused = true;
  wave.reset();
  assert.ok(bars.every(bar => bar.style.height === '3px'));
  active = true;
  video.paused = false;
  await wave.start();
  assert.equal(created, 1, 'a media element can have only one source node');
});

test('a cross-origin source is left on the browser audio path', async () => {
  let created = false;
  const wave = new AudioWaveform({src: 'https://other.example/audio.mp3'}, [], () => true, {
    Context: class { constructor() { created = true; } }, origin: 'http://localhost',
  });
  await wave.start();
  assert.equal(created, false);
});

test('bars elsewhere follow the same analyser, at their own height, and are handed back', async () => {
  let created = 0;
  const context = {
    state: 'running', destination: {},
    createMediaElementSource() { created++; return {connect() {}}; },
    createAnalyser() {
      return {fftSize: 0, getByteTimeDomainData(data) { data.fill(255); }};
    },
  };
  const video = {src: '/song.m4a', paused: false, muted: false, volume: 1};
  // The player shows a picture, so its own bars are not wanted.
  const own = [{style: {height: ''}}];
  const wave = new AudioWaveform(video, own, () => false, {
    Context: class { constructor() { return context; } }, origin: 'http://localhost',
    requestFrame: () => 1, cancelFrame: () => {},
  });
  const row = {dataset: {}, children: [{style: {height: ''}}, {style: {height: ''}}]};
  const stop = wave.follow(row, {min: 3, max: 12});
  await wave.starting;
  assert.equal(created, 1, 'following starts the analyser while something plays');
  assert.ok('live' in row.dataset);
  assert.ok(row.children.every(bar => parseFloat(bar.style.height) > 3 && parseFloat(bar.style.height) <= 12));
  assert.equal(own[0].style.height, '', 'the player\'s hidden bars are left alone');

  stop();
  assert.equal('live' in row.dataset, false);
  assert.ok(row.children.every(bar => bar.style.height === ''));
});
