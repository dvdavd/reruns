import test from 'node:test';
import assert from 'node:assert/strict';
import {cardThumbnailSizes, sizedThumbnail, thumbnailSrcset} from '../web/thumbnail-sizes.js';
import {toMediaItem} from '../web/item-adapter.js';

test('only this archive\'s thumbnails are asked for at a size', () => {
  assert.equal(sizedThumbnail('/thumb/a%20b.info.json', 256), '/thumb/a%20b.info.json?w=256');
  assert.equal(sizedThumbnail('https://i.ytimg.com/x.jpg', 256), 'https://i.ytimg.com/x.jpg');
  assert.equal(sizedThumbnail(undefined, 256), '');
  assert.equal(thumbnailSrcset('https://i.ytimg.com/x.jpg'), '');
  assert.equal(thumbnailSrcset(''), '');
});

test('a card\'s thumbnail offers the browser a copy for each width the server makes', () => {
  const item = toMediaItem({_key: 'a.info.json', _serves: 'media thumb'});
  assert.equal(item.thumbnail.url, '/thumb/a.info.json');
  assert.equal(item.thumbnail.srcset, ['480', '640', '960', '1280', '1920']
    .map(width => `/thumb/a.info.json?w=${width} ${width}w`).join(', '));
});

test('a card\'s width follows the card size, for browsers that cannot measure it', () => {
  const globals = {document: globalThis.document};
  try {
    globalThis.document = {body: {dataset: {cardSize: 'large'}}};
    assert.equal(cardThumbnailSizes(), 'min(100vw, calc(clamp(480px, 28vw, 700px) * 1.15))');
    globalThis.document = {body: {dataset: {}}};
    assert.equal(cardThumbnailSizes(), 'min(100vw, calc(clamp(380px, 21vw, 520px) * 1.15))');
  } finally {
    Object.assign(globalThis, globals);
  }
});
