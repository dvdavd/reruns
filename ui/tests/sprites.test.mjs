// A sprite's glyphs are drawn from the file until the sprite is in the page,
// so a card drawn before then, or anywhere with no page at all, is never blank.
import assert from 'node:assert/strict';
import test from 'node:test';

import {inlineSprite, spriteHref} from '../shared/lib/sprites.js';
import {iconHref} from '../shared/components/icons.js';

test('an address is left as it is while its sprite is not in the page', async () => {
  await inlineSprite('/icons.svg');  // No document here, so nothing to bring it into.
  assert.equal(spriteHref('/icons.svg#eye'), '/icons.svg#eye');
  assert.match(iconHref('eye'), /\/shared\/icons\.svg#eye$/);
  assert.equal(spriteHref(''), '');
  assert.equal(spriteHref('/plain.svg'), '/plain.svg');
});
