// The picker is a way of writing yt-dlp's own comma-separated tag list, so
// what matters is that ticking and typing agree on the same string.
import assert from 'node:assert/strict';
import test from 'node:test';

import {baseTag, formatLanguageTags, languageName, parseLanguageTags,
        suggestedLanguages, toggleLanguage} from '../web/subtitle-languages.js';

test('a tag means the language, wildcard or not', () => {
  assert.equal(baseTag(' en.* '), 'en');
  assert.equal(baseTag('pt-BR'), 'pt-BR');
  assert.deepEqual(parseLanguageTags('en.*, de ,,en'), ['en', 'de']);
  assert.equal(formatLanguageTags(['en', 'de.*']), 'en.*,de.*');
});

test('ticking adds a language and unticking takes it away', () => {
  assert.equal(toggleLanguage('en.*', 'de'), 'en.*,de.*');
  assert.equal(toggleLanguage('en.*,de.*', 'en'), 'de.*');
  // A language typed without the wildcard is still the one that is ticked.
  assert.equal(toggleLanguage('de', 'de.*'), '');
});

test('what is asked for is offered first, so a typed tag can be unticked', () => {
  const offered = suggestedLanguages('cy.*,en');
  assert.deepEqual(offered.slice(0, 2), ['cy', 'en']);
  assert.equal(new Set(offered).size, offered.length);
  assert.ok(offered.includes('ja'));
});

test('languages are named rather than spelled in tags', () => {
  assert.equal(languageName('ja'), 'Japanese');
  assert.equal(languageName('en.*'), 'English');
});

test('audio tags stay plain, since a format filter already matches a prefix', () => {
  assert.equal(toggleLanguage('', 'en', ''), 'en');
  assert.equal(toggleLanguage('en', 'de', ''), 'en,de');
  assert.equal(toggleLanguage('en,de', 'en', ''), 'de');
  // The order ticked is the order kept, so it is the order the player lists.
  assert.equal(toggleLanguage('de,en', 'fr', ''), 'de,en,fr');
  assert.equal(formatLanguageTags(['en.*', 'de'], ''), 'en,de');
});
