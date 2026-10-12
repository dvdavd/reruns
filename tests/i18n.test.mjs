import assert from 'node:assert/strict';
import test from 'node:test';

import {locale, plural, t, translateMarkup, useLocale} from '../web/i18n.js';
import gb from '../web/locales/en-GB.js';
import us from '../web/locales/en-US.js';

test('a locale lists only what it words differently, and every key it lists exists in en-GB', () => {
  for (const key of Object.keys(us)) assert.ok(key in gb, `${key} is only in en-US`);
});

test('en-US overrides spellings and everything else falls back to en-GB', async () => {
  await useLocale('en-GB');
  assert.equal(t('appearance.colours'), 'Colours');
  await useLocale('en-US');
  assert.equal(locale(), 'en-US');
  assert.equal(t('appearance.colours'), 'Colors');
  assert.equal(t('appearance.title'), 'Appearance');
  await useLocale('xx');
  assert.equal(locale(), 'en-GB');
});

test('an unwritten key shows as itself and values fill {names}', async () => {
  await useLocale('en-GB');
  assert.equal(t('no.such.key'), 'no.such.key');
});

test('plural picks a form by the locale\'s own rules', async () => {
  await useLocale('en-GB');
  // Catalogues gain count keys as modules move over; this checks the mechanism.
  gb['test.videos'] = {one: '{count} video', other: '{count} videos'};
  assert.equal(plural('test.videos', 1), '1 video');
  assert.equal(plural('test.videos', 3), '3 videos');
  delete gb['test.videos'];
});

// A stand-in for the few DOM members translateMarkup touches.
function element(dataset, {children = [], first = null} = {}) {
  return {dataset, children, childNodes: first ? [first] : [], textContent: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; },
    replaceChildren(...nodes) { this.replaced = nodes; }};
}

test('markup keeps a trailing child and sets attributes', async () => {
  await useLocale('en-US');
  const leading = {nodeType: 3, textContent: 'Adaptive'};
  const label = element({i18n: 'appearance.colours'});
  const mixed = element({i18n: 'appearance.video-colours'}, {children: [{}], first: leading});
  const button = element({i18nAttrs: 'aria-label:appearance.close, title:appearance.reset'});
  translateMarkup({querySelectorAll: selector => ({
    '[data-i18n]': [label, mixed], '[data-i18n-attrs]': [button],
  })[selector]});
  assert.equal(label.textContent, 'Colors');
  assert.equal(leading.textContent, 'Adaptive watch page theme');
  assert.deepEqual(button.attrs, {'aria-label': 'Close appearance settings', title: 'Restore default appearance'});
});

test('every key the page asks for is in the en-GB catalogue', async () => {
  const {readdir, readFile} = await import('node:fs/promises');
  const web = new URL('../web/', import.meta.url);
  const used = new Set();
  for (const file of await readdir(web)) {
    if (!/\.(js|html)$/.test(file) || file === 'i18n.js') continue;
    const source = await readFile(new URL(file, web), 'utf8');
    for (const [, key] of source.matchAll(/\b(?:t|plural)\('([\w.-]+)'/g)) used.add(key);
    for (const [, key] of source.matchAll(/data-i18n="([\w.-]+)"/g)) used.add(key);
    for (const [, list] of source.matchAll(/data-i18n-attrs="([^"]+)"/g)) {
      for (const pair of list.split(',')) used.add(pair.split(':')[1].trim());
    }
  }
  assert.ok(used.size > 40);
  for (const key of used) assert.ok(key in gb, `${key} is not in en-GB`);
});

test('US English spells the counted favourites its own way', async () => {
  await useLocale('en-US');
  assert.equal(plural('count.favourites', 1), '1 favorite');
  assert.equal(plural('count.favourites', 2), '2 favorites');
  await useLocale('en-GB');
  assert.equal(plural('count.favourites', 2), '2 favourites');
});

test('a module that calls t() or plural() imports it', async () => {
  // Nothing else catches a missing import until the line runs in a browser.
  const {readdir, readFile} = await import('node:fs/promises');
  const web = new URL('../web/', import.meta.url);
  for (const file of await readdir(web)) {
    if (!file.endsWith('.js') || file === 'i18n.js') continue;
    const source = await readFile(new URL(file, web), 'utf8');
    const imported = new Set((source.match(/import \{([^}]*)\} from '\.\/i18n\.js'/)?.[1] ?? '')
      .split(',').map(name => name.trim()));
    for (const name of ['t', 'plural']) {
      if (new RegExp(`(?<![\\w.])${name}\\('`).test(source)) {
        assert.ok(imported.has(name), `${file} calls ${name}() without importing it`);
      }
    }
  }
});

test('a sentence written with {child} wraps its one child element', async () => {
  await useLocale('en-GB');
  gb['test.code'] = 'Only files with a {child} name count.';
  const child = {};
  const sentence = element({i18n: 'test.code'}, {children: [child]});
  translateMarkup({querySelectorAll: selector => ({'[data-i18n]': [sentence], '[data-i18n-attrs]': []})[selector]});
  assert.deepEqual(sentence.replaced, ['Only files with a ', child, ' name count.']);
  delete gb['test.code'];
});

test('a sentence with several elements takes them in order, and one with none is left alone', async () => {
  await useLocale('en-GB');
  gb['test.credit'] = 'Data under {child1} from {child2}.';
  const [licence, site] = [{}, {}];
  const credit = element({i18n: 'test.credit'}, {children: [licence, site]});
  translateMarkup({querySelectorAll: selector => ({'[data-i18n]': [credit], '[data-i18n-attrs]': []})[selector]});
  assert.deepEqual(credit.replaced, ['Data under ', licence, ' from ', site, '.']);
  delete gb['test.credit'];
});
