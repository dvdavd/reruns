import assert from 'node:assert/strict';
import test from 'node:test';
import {mp4Fragments} from '../web/mp4-fragments.js';

const box = (type, bytes = [], extended = false) => {
  const result = new Uint8Array((extended ? 16 : 8) + bytes.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, extended ? 1 : result.length);
  result.set([...type].map(letter => letter.charCodeAt(0)), 4);
  if (extended) view.setBigUint64(8, BigInt(result.length));
  result.set(bytes, extended ? 16 : 8);
  return result;
};
const join = (...parts) => Uint8Array.from(parts.flatMap(part => [...part]));
const parse = async (bytes, step) => {
  let at = 0;
  const reader = {async read() {
    if (at >= bytes.length) return {done: true};
    const value = bytes.subarray(at, at + step); at += step;
    return {done: false, value};
  }};
  const result = [];
  for await (const fragment of mp4Fragments(reader, new AbortController().signal)) result.push(fragment);
  return result;
};

test('append units preserve complete init and media segments across arbitrary network chunks', async () => {
  const init = join(box('ftyp', [1]), box('moov', [2, 3]));
  const first = join(box('moof', [4]), box('mdat', [5, 6, 7], true));
  const second = join(box('moof', [8]), box('mdat', [9]));
  const data = join(init, first, second, box('mfra'));
  for (const step of [1, 7, 15, 65536]) {
    assert.deepEqual(await parse(data, step), [init, first, second]);
  }
});

test('truncated media is rejected before it can poison the SourceBuffer', async () => {
  const data = join(box('moof'), box('mdat', [1, 2, 3]));
  await assert.rejects(parse(data.subarray(0, data.length - 1), 2), /Incomplete MP4 fragment/);
  await assert.rejects(parse(box('moof'), 3), /Incomplete MP4 fragment/);
});

test('invalid sizes and cancelled reads do not append any data', async () => {
  const malformed = box('moov');
  new DataView(malformed.buffer).setUint32(0, 4);
  await assert.rejects(parse(malformed, 8), /Invalid MP4 box size/);
  const controller = new AbortController(); controller.abort();
  const iterator = mp4Fragments({read() { throw new Error('should not read'); }}, controller.signal);
  await assert.rejects(iterator.next(), {name: 'AbortError'});
});
