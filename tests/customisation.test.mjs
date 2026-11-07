import test from 'node:test';
import assert from 'node:assert/strict';

// customisation.js reads its settings as it loads, so each case loads a fresh
// copy over its own storage.
let copy = 0;
async function load(held) {
  const values = new Map(Object.entries(held));
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
  };
  const events = [];
  globalThis.document = {body: {dataset: {}}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => []};
  globalThis.window = {dispatchEvent: event => events.push(event.type), addEventListener() {}};
  const module = await import(`../web/customisation.js?copy=${++copy}`);
  return {module, values, events};
}

test('the old three-way lighting choice carries over to the glow and backing off', async () => {
  const cases = [
    [{'archive-player-lighting': 'on'}, 'on', false],
    [{'archive-player-lighting': 'automatic'}, 'on', true],
    [{'archive-player-lighting': 'off'}, 'off', true],
    [{'archive-player-lighting': 'realtime'}, 'on', false],
    [{'archive-player-lighting': 'efficient'}, 'on', true],
    [{}, 'off', true],
  ];
  for (const [held, glow, backsOff] of cases) {
    const {module} = await load(held);
    assert.equal(module.playerLightingMode(), glow, JSON.stringify(held));
    assert.equal(module.glowBacksOff(), backsOff, JSON.stringify(held));
  }
});

test('a choice under the new keys outranks the old one', async () => {
  const {module} = await load({
    'archive-player-lighting': 'on',
    'archive-player-glow': 'off',
    'archive-performance-backoff': 'on',
  });
  assert.equal(module.playerLightingMode(), 'off');
  assert.equal(module.glowBacksOff(), true);
});

test('backing off holds the glow back on this device until it is turned on again', async () => {
  const {module, values, events} = await load({'archive-player-glow': 'on'});
  assert.equal(module.playerGlowShown(), true);
  module.suspendGlow();
  assert.equal(module.glowHeldBack(), true);
  assert.equal(module.playerGlowShown(), false);
  assert.equal(document.body.dataset.playerLighting, 'off');
  assert.equal(values.get('archive-glow-suspended'), '1');
  // The account's choice stays on, or the glow would go on every device.
  assert.equal(values.get('archive-player-glow'), 'on');
  assert.ok(events.includes('archive-lighting-change'));
  module.setPlayerGlow(true);
  assert.equal(module.glowHeldBack(), false);
  assert.equal(module.playerGlowShown(), true);
  assert.equal(values.has('archive-glow-suspended'), false);
});

test('a device held back from before shows the glow once backing off is not wanted', async () => {
  const {module} = await load({
    'archive-player-glow': 'on',
    'archive-performance-backoff': 'off',
    'archive-glow-suspended': '1',
  });
  assert.equal(module.glowHeldBack(), false);
  assert.equal(module.playerGlowShown(), true);
});

test('turning the glow off is not shown as held back', async () => {
  const {module} = await load({'archive-player-glow': 'on'});
  module.suspendGlow();
  module.setPlayerGlow(false);
  assert.equal(module.glowHeldBack(), false);
  assert.equal(module.playerGlowShown(), false);
});
