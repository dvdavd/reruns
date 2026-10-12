// Icons come out of the shared sprite, and where that sprite is served from is
// the package's to know. These hold the page to asking rather than assuming.
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import test from 'node:test';

import {iconHref} from 'media-ui';
import {icon, iconMarkup} from '../web/icon.js';

test('a glyph points at the sprite the package resolved', () => {
  assert.equal(iconMarkup('x'),
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="${iconHref('x')}"/></svg>`);
  assert.match(iconHref('x'), /\/shared\/icons\.svg#x$/);
});

test('a glyph carries any extra classes the caller asks for', () => {
  assert.match(iconMarkup('x', 'topbar-go-download'), /class="icon topbar-go-download"/);
  assert.equal(icon('x').props.class, 'icon');
  assert.equal(icon('x', 'wide').props.class, 'icon wide');
});

test('no module writes the sprite path out for itself', async () => {
  // The mount point is declared once, in the import map; a module that spelled
  // it out again would break the day server.py served the package elsewhere.
  for (const name of (await readdir('web')).filter(file => file.endsWith('.js'))) {
    const source = await readFile(`web/${name}`, 'utf8');
    assert.doesNotMatch(source, /icons\.svg/, name);
  }
});
