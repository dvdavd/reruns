// Render contract for the shared video row. The app's CSS and delegated
// listeners read these class names and data-* attributes, so a change here
// is a change to every panel list.
import assert from 'node:assert/strict';
import test from 'node:test';

import render from '../vendor/preact/render-to-string.module.js';
import {html} from '../shared/lib/html.js';
import {MediaRow} from '../shared/components/MediaRow.js';

const draw = (props, body = 'Title') => render(html`<${MediaRow} ...${props}>${body}<//>`);

test('a row is a divided list item at the regular size by default', () => {
  assert.match(draw({}), /^<li class="media-row media-row--divided" data-size="regular"/);
});

test('the element, size and title clamp are the caller\'s to choose', () => {
  const out = draw({as: 'button', size: 'compact', lines: 1, divided: false, type: 'button'});
  assert.match(out, /^<button class="media-row"/);
  assert.match(out, /data-size="compact"/);
  assert.match(out, /--media-row-lines:\s*1/);
  assert.doesNotMatch(out, /divided/);
});

test('the lead, duration and actions appear only when given', () => {
  assert.doesNotMatch(draw({}), /media-row-lead|media-row-duration|media-row-actions/);
  const out = draw({lead: 3, duration: '1:02', thumbnail: '/t.jpg', actions: html`<b>go</b>`});
  assert.match(out, /<span class="media-row-lead">3<\/span>/);
  assert.match(out, /<img src="\/t.jpg"/);
  assert.match(out, /<span class="media-row-duration">1:02<\/span>/);
  assert.match(out, /<div class="media-row-actions"><b>go<\/b><\/div>/);
});

test('the fallback stands in only when there is no picture', () => {
  assert.match(draw({fallback: html`<i>icon</i>`}), /<i>icon<\/i>/);
  assert.doesNotMatch(draw({thumbnail: '/t.jpg', fallback: html`<i>icon</i>`}), /<i>icon<\/i>/);
});

test('an avatar row is marked round, and extra classes and attributes pass through', () => {
  const out = draw({round: true, class: 'subscription-item', 'data-kind': 'channel'});
  assert.match(out, /class="media-row media-row--divided subscription-item"/);
  assert.match(out, /data-round="true"/);
  assert.match(out, /data-kind="channel"/);
});
