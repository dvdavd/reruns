import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import test from 'node:test';

import {serverMessage, useLocale} from '../web/i18n.js';
import gb from '../web/locales/en-GB.js';
import us from '../web/locales/en-US.js';

const keyFor = text => Object.keys(gb).find(key => key.startsWith('server.') && gb[key] === text);

test('a refusal is said again in the chosen language, with its values carried over', async () => {
  const plain = keyFor('Invalid byte range');
  const templated = keyFor('Could not create {path}: {error}');
  assert.ok(plain && templated);
  await useLocale('en-US');
  us[plain] = 'That range is wrong';
  us[templated] = 'Cannot make {path} ({error})';
  try {
    // http.server ends its message with a full stop, which is kept.
    assert.equal(serverMessage('Invalid byte range.'), 'That range is wrong.');
    assert.equal(serverMessage('Invalid byte range'), 'That range is wrong');
    assert.equal(serverMessage('Could not create /srv/a: denied.'), 'Cannot make /srv/a (denied).');
  } finally {
    delete us[plain];
    delete us[templated];
    await useLocale('en-GB');
  }
});

test('what the catalogue does not know is shown as it came', async () => {
  await useLocale('en-GB');
  assert.equal(serverMessage('ERROR: [youtube] abc: Video unavailable'), 'ERROR: [youtube] abc: Video unavailable');
  assert.equal(serverMessage(''), '');
  // A plain message is never read as a template for another.
  assert.equal(serverMessage('Sign in required.'), 'Sign in required.');
});

test('every server message in the catalogue is still worded that way by the server', async () => {
  const dir = new URL('../reruns/', import.meta.url);
  let source = '';
  for (const file of await readdir(dir)) if (file.endsWith('.py')) source += await readFile(new URL(file, dir), 'utf8');
  for (const [key, text] of Object.entries(gb)) {
    if (!key.startsWith('server.')) continue;
    // The pieces around the values, which are all the server writes literally.
    for (const piece of text.split(/\{\w+\}/).map(part => part.trim()).filter(part => part.length > 3)) {
      assert.ok(source.includes(piece), `${key}: the server no longer says "${piece}"`);
    }
  }
});
