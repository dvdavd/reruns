// How a component takes its words from an app: defaults, text with {values},
// and functions, with whatever is left out falling back to English.
import assert from 'node:assert/strict';
import test from 'node:test';

import {createSay, escapeMarkup} from '../shared/lib/labels.js';
import {DEFAULT_PLAYER_LABELS} from '../shared/components/MediaPlayer.js';
import {DEFAULT_LABELS} from '../shared/components/VideoCard.js';

test('a label is text with values, a function of them, or the default', () => {
  const say = createSay({greeting: 'Hello {name}', count: 'a thing'});
  assert.equal(say(undefined, 'greeting', {name: 'Sam'}), 'Hello Sam');
  assert.equal(say({greeting: 'Hallo {name}'}, 'greeting', {name: 'Sam'}), 'Hallo Sam');
  assert.equal(say({count: values => `${values.n} things`}, 'count', {n: 3}), '3 things');
  assert.equal(say({}, 'greeting'), 'Hello {name}', 'a value not given is left as written');
});

test('the card and the player have an English default for every word they use', () => {
  for (const defaults of [DEFAULT_LABELS, DEFAULT_PLAYER_LABELS]) {
    for (const [key, value] of Object.entries(defaults)) {
      assert.equal(typeof value, 'string', `${key} should default to text`);
      assert.ok(value.trim(), `${key} should not be empty`);
    }
  }
});

test('a label written into markup cannot end the attribute it sits in', () => {
  assert.equal(escapeMarkup('Lecteur "vidéo" & <son>'), 'Lecteur &#34;vidéo&#34; &#38; &#60;son&#62;');
  assert.equal(escapeMarkup("l'image"), 'l&#39;image');
});
