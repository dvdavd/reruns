import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('a touch on a hidden control bar does not start the hold-to-speed press', async () => {
  const source = await readFile(new URL('../web/player-speed.js', import.meta.url), 'utf8');
  const start = source.indexOf("element.addEventListener('pointerdown', event => {\n    endHold();");
  assert.ok(start > 0);
  const handler = source.slice(start, source.indexOf('}, {capture: true});', start));
  assert.match(handler, /pointerType !== 'mouse' && mediaPlayer\.root\.classList\.contains\('is-controls-hidden'\)\) return;/);
  // The guard must come before the timer that arms the hold.
  assert.ok(handler.indexOf('is-controls-hidden') < handler.indexOf('setTimeout'));
});
