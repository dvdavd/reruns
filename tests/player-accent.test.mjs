import assert from 'node:assert/strict';
import test from 'node:test';

import {samplePosterAccent} from '../web/player-watch.js';

function poster(src) {
  const listeners = [];
  return {
    src, complete: false, naturalWidth: 0,
    getAttribute(name) { return name === 'src' ? this.src : null; },
    addEventListener(name, listener) { if (name === 'load') listeners.push(listener); },
    load() {
      this.complete = true;
      this.naturalWidth = 320;
      for (const listener of listeners.splice(0)) listener();
    },
  };
}

test('an uncached poster can colour the current video after a details redraw', () => {
  const item = {id: 'short'};
  const image = poster('/thumb/short');
  let activeId = item.id;
  const applied = [];
  const sample = () => 'oklch(62% 0.12 45)';
  samplePosterAccent(item, image, () => activeId, colour => applied.push(colour), sample);
  // The details request redraws while the thumbnail is still in flight.
  image.load();
  assert.deepEqual(applied, ['oklch(62% 0.12 45)']);
  assert.equal(item.accent, applied[0]);

  const next = {id: 'next'};
  const oldImage = poster('/thumb/old');
  samplePosterAccent(next, oldImage, () => activeId, colour => applied.push(colour), sample);
  activeId = 'another';
  oldImage.load();
  assert.equal(next.accent, undefined);

  activeId = next.id;
  const changedImage = poster('/thumb/next');
  samplePosterAccent(next, changedImage, () => activeId, colour => applied.push(colour), sample);
  changedImage.src = '/thumb/different';
  changedImage.load();
  assert.equal(next.accent, undefined);
});
