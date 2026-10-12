import {readStyles} from './styles-source.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const html = await readFile('web/index.html', 'utf8');
const appSource = await readFile('web/app.js', 'utf8');
const styles = await readStyles();

test('the header is one shared topbar rather than the old two-row shell', () => {
  assert.match(html, /<header class="topbar">/);
  assert.doesNotMatch(html, /archive-header/);
  assert.doesNotMatch(styles, /\.archive-header|\.archive-controls/);
  // The chrome sheet is what gives those class names their appearance.
  assert.match(html, /href="\/media-ui\/shared\/chrome\.css"/);
});

test('search is the topbar centrepiece and carries its own clear button', () => {
  const topbar = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.match(topbar, /class="topbar-search"[\s\S]*id="archive-search"/);
  assert.match(topbar, /id="archive-search-clear" class="search-clear-button"/);
});

test('a pasted link turns the search into a download bar', () => {
  const topbar = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.doesNotMatch(html, /archive-add-toggle|id="download-url"/);
  assert.match(topbar, /<form id="download-form" class="topbar-search" data-mode="search" data-filled="false">/);
  assert.match(topbar, /class="topbar-go"[\s\S]*id="download-submit"[\s\S]*id="download-advanced-toggle"[\s\S]*id="download-subscribe"/);
  assert.match(html, /<div id="download-advanced" class="menu-popover download-advanced" popover="manual"/);
  // Subscribe is revealed by widening it from nothing rather than by display,
  // so the switch into a download bar animates.
  assert.match(styles, /\.topbar-search\[data-mode="link"\] \.topbar-subscribe \{ width: 90px;/);
});

test('settings is a menu wired through the shared chrome helper', () => {
  assert.match(html, /id="archive-settings-menu" class="settings-menu" role="menu" hidden/);
  assert.doesNotMatch(html, /data-settings-action="rescan"/);
  assert.match(appSource, /createMenu\(\{[\s\S]*?#archive-settings-toggle/);
});

test('sorting lives on the gallery heading, not in the topbar', () => {
  assert.doesNotMatch(html, /archive-sort-toggle|archive-sort-menu/);
  assert.match(html, /class="section-heading library-heading"[\s\S]*?id="gallery-sort"/);
});

test('the status line is the shared toast', () => {
  assert.match(html, /id="status-toast" class="status-toast"/);
  assert.doesNotMatch(html, /app-status/);
  assert.match(appSource, /createStatusToast\(/);
});

test('page content is laid out against the shared gutter token', async () => {
  // The topbar's own inline padding defines the line the brand title sits on,
  // so the shell reads that token rather than repeating the number.
  assert.match(styles, /padding-inline: var\(--page-gutter\)/);
  assert.doesNotMatch(styles, /--page-gutter:/);
  const tokens = await readFile('ui/shared/tokens.css', 'utf8');
  assert.match(tokens, /--page-gutter: 14px/);
  const chrome = await readFile('ui/shared/chrome.css', 'utf8');
  assert.match(chrome, /\.topbar \{[^}]*padding: 6px var\(--page-gutter\)/);
});

test('the go arrow offers saved profiles above the manual overrides', () => {
  assert.match(html, /<div id="download-profile-menu" class="download-profile-menu" role="menu"/);
  // The manual selects are the ones that were always there, now behind a choice.
  assert.match(html, /<div id="download-manual" class="download-manual" hidden>[\s\S]*?name="media"/);
  // The arrow is download settings only; how often a subscription checks, and
  // what it does with the backlog, moved to the subscriptions drawer. Read
  // only as far as <main>: the channel and playlist pages have frequency
  // pills of their own.
  assert.doesNotMatch(html.split('id="download-advanced"')[1].split('<main')[0],
    /interval|backlog/);
  assert.match(styles, /\.download-profile-menu button\[role="menuitemradio"\]/);
});

test('download profiles are a drawer of their own, opened from the settings menu', () => {
  assert.match(html, /data-settings-action="profiles"/);
  assert.match(html, /<dialog id="profiles-drawer" class="download-drawer"/);
  assert.match(html, /id="profiles-summary"/);
  assert.match(appSource, /createProfilesUI\(\{[\s\S]*?#profiles-drawer/);
  assert.match(appSource, /settingsAction === 'profiles'\) profiles\.open\(\)/);
});

test('what a new subscription starts with is set in its own drawer', () => {
  assert.match(html, /<section class="customisation-group subscription-defaults"[\s\S]*?id="subscriptions-interval"[\s\S]*?id="subscriptions-backlog"/);
  assert.match(appSource, /intervalSelect: document\.querySelector\('#subscriptions-interval'\)/);
});
