import assert from 'node:assert/strict';
import test from 'node:test';
import {immersiveDelayMs, immersiveOverlapsLogo, initialisePlayerImmersive} from '../web/player-immersive.js';

test('immersion defaults to twenty seconds for missing or invalid preferences', () => {
  for (const value of [null, undefined, '', 'invalid', '-1', '15']) {
    assert.equal(immersiveDelayMs(value), 20_000);
  }
});

test('background shelf redraws do not postpone or exit immersion, while menu changes rearm it', t => {
  const classes = new Set(['watch-open']);
  const classList = {contains: name => classes.has(name), add: name => classes.add(name),
    remove: name => classes.delete(name)};
  const stage = {style: {setProperty() {}},
    getBoundingClientRect: () => ({width: 640, height: 360, top: 100})};
  const page = {hidden: false, classList: {contains: () => false},
    querySelector: selector => selector === '.archive-watch-stage' ? stage : null,
    querySelectorAll: () => []};
  const observers = [];
  const timers = new Map();
  let nextTimer = 0;
  let menuOpen = false;
  let portraitMobile = false;
  for (const [name, value] of Object.entries({
    document: {body: {classList}, hidden: false, activeElement: null,
      querySelector: selector => selector === '.topbar' ? null : menuOpen ? {} : null,
      addEventListener() {}},
    window: {scrollY: 0, innerWidth: 1024, addEventListener() {}},
    matchMedia: query => ({matches: portraitMobile && query === '(max-width: 700px) and (orientation: portrait)'}),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
    },
    setTimeout: (callback, delay) => { timers.set(++nextTimer, {callback, delay}); return nextTimer; },
    clearTimeout: id => timers.delete(id),
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  initialisePlayerImmersive(page, {root: {classList: {contains: () => false}},
    video: {paused: false, ended: false, addEventListener() {}}}, {idleMs: 10_000});
  const menuObserver = observers.find(observer => observer.options.subtree);
  assert.equal(menuObserver.options.attributeOldValue, true);
  const initialTimer = nextTimer;
  const shelfRedraw = [{attributeName: 'aria-expanded', oldValue: 'false',
    target: {getAttribute: () => 'false'}}];
  menuObserver.callback(shelfRedraw);
  assert.equal(nextTimer, initialTimer, 'unchanged writes must not restart the delay');
  assert.equal(timers.get(initialTimer).delay, 10_000);
  const {callback} = timers.get(initialTimer);
  timers.delete(initialTimer);
  callback();
  assert.equal(classes.has('is-player-immersive'), true);
  menuObserver.callback(shelfRedraw);
  assert.equal(classes.has('is-player-immersive'), true, 'background redraw must not exit immersion');
  menuOpen = true;
  menuObserver.callback([{attributeName: 'aria-expanded', oldValue: 'false',
    target: {getAttribute: () => 'true'}}]);
  assert.equal(classes.has('is-player-immersive'), false);
  assert.equal(timers.size, 0);
  menuOpen = false;
  menuObserver.callback([{attributeName: 'aria-expanded', oldValue: 'true',
    target: {getAttribute: () => 'false'}}]);
  assert.equal(timers.get(nextTimer).delay, 10_000, 'closing a menu restarts the delay');
  portraitMobile = true;
  const pending = timers.get(nextTimer);
  timers.delete(nextTimer);
  pending.callback();
  assert.equal(classes.has('is-player-immersive'), false, 'portrait mobile cannot enter immersion');
  menuObserver.callback([{attributeName: 'aria-expanded', oldValue: 'true',
    target: {getAttribute: () => 'false'}}]);
  assert.equal(timers.size, 0, 'portrait mobile does not schedule immersion');
  portraitMobile = false;
  menuObserver.callback([{attributeName: 'aria-expanded', oldValue: 'true',
    target: {getAttribute: () => 'false'}}]);
  assert.equal(timers.get(nextTimer).delay, 10_000, 'leaving portrait mobile enables immersion again');

});

test('immersion supports Off and every offered inactivity delay', () => {
  for (const seconds of [0, 2, 5, 10, 20, 30]) {
    assert.equal(immersiveDelayMs(String(seconds)), seconds * 1000);
  }
});

test('desktop logo hides only when the enlarged stage intersects its bounds', () => {
  const logo = {left: 24, right: 84, top: 20, bottom: 56};
  const stage = {left: 90, top: 70, width: 800, height: 450};
  assert.equal(immersiveOverlapsLogo(stage, logo, 1, 0), false);
  assert.equal(immersiveOverlapsLogo(stage, logo, 1.15, 18), true);
  assert.equal(immersiveOverlapsLogo({...stage, left: 200}, logo, 1.15, 18), false);
  assert.equal(immersiveOverlapsLogo({...stage, top: 150}, logo, 1.15, 18), false);
});
