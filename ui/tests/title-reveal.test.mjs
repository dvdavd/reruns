import test from 'node:test';
import assert from 'node:assert/strict';
import {revealClippedTitles, titleIsClipped} from '../shared/lib/title-reveal.js';

// Enough of a card for the module: the words it measures, and a title copy
// whose position moves left by the portrait's 50px once the card is revealed.
function fakeCard({scrollWidth}) {
  const card = {dataset: {}, contains: node => node === card || node === name};
  const name = {scrollWidth, clientWidth: 200, closest: () => card};
  const animations = [];
  const copy = {
    getBoundingClientRect: () => ({left: 'titleReveal' in card.dataset ? 0 : 50}),
    getAnimations: () => animations,
    animate(frames) {
      const animation = {frames, cancel() {}, finished: new Promise(() => {})};
      animations.push(animation);
      return animation;
    },
  };
  card.querySelector = () => copy;
  card.querySelectorAll = () => [name];
  return {card, name, copy, animations};
}

function fakeRoot() {
  const listeners = {};
  return {listeners, contains: () => true, addEventListener: (type, fn) => { listeners[type] = fn; }};
}

test('a title is clipped only when its text is wider than its box', () => {
  assert.equal(titleIsClipped(fakeCard({scrollWidth: 320}).card), true);
  assert.equal(titleIsClipped(fakeCard({scrollWidth: 200}).card), false);
});

test('hovering a card whose words fit leaves it alone', () => {
  const root = fakeRoot();
  revealClippedTitles(root, {reducedMotion: () => false});
  const {card, name, animations} = fakeCard({scrollWidth: 200});
  root.listeners.pointerover({pointerType: 'mouse', target: name, relatedTarget: null});
  assert.equal('titleReveal' in card.dataset, false);
  assert.equal(animations.length, 0);
});

test('hovering a clipped title slides it from where it stood, and back', () => {
  const root = fakeRoot();
  revealClippedTitles(root, {reducedMotion: () => false});
  const {card, name, animations} = fakeCard({scrollWidth: 320});
  root.listeners.pointerover({pointerType: 'mouse', target: name, relatedTarget: null});
  assert.equal('titleReveal' in card.dataset, true);
  assert.deepEqual(animations[0].frames[0], {left: '50px'});
  root.listeners.pointerout({pointerType: 'mouse', target: name, relatedTarget: null});
  assert.equal('titleReveal' in card.dataset, false);
  assert.deepEqual(animations[1].frames[0], {left: '-50px'});
});

test('moving within a card is not a crossing', () => {
  const root = fakeRoot();
  revealClippedTitles(root, {reducedMotion: () => false});
  const {card, name} = fakeCard({scrollWidth: 320});
  root.listeners.pointerover({pointerType: 'mouse', target: name, relatedTarget: card});
  assert.equal('titleReveal' in card.dataset, false);
});

test('with a dwell, a card is revealed only once the pointer rests on it', () => {
  const root = fakeRoot();
  const timers = [];
  revealClippedTitles(root, {
    dwell: 250, reducedMotion: () => false,
    schedule: fn => timers.push(fn) - 1, unschedule: id => { if (id != null) timers[id] = null; },
  });
  const passing = fakeCard({scrollWidth: 320});
  root.listeners.pointerover({pointerType: 'mouse', target: passing.name, relatedTarget: null});
  root.listeners.pointerout({pointerType: 'mouse', target: passing.name, relatedTarget: null});
  timers.forEach(fn => fn?.());
  assert.equal('titleReveal' in passing.card.dataset, false);

  const resting = fakeCard({scrollWidth: 320});
  root.listeners.pointerover({pointerType: 'mouse', target: resting.name, relatedTarget: null});
  assert.equal('titleReveal' in resting.card.dataset, false);
  timers.forEach(fn => fn?.());
  assert.equal('titleReveal' in resting.card.dataset, true);
});
