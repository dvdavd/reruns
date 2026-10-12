import test from 'node:test';
import assert from 'node:assert/strict';
import {DIRECTORY_KEY, directoryRows, inDirectory, offersDirectories, readDirectory, saveDirectory}
  from '../web/directories.js';

const entry = (library, path, count = 1) => ({
  library, path, name: path.split('/').pop() || library, count, key: `${library}/${path ? `${path}/` : ''}`,
});
const memory = (initial = {}) => {
  const data = {...initial};
  return {getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = String(value); },
    removeItem: key => { delete data[key]; }, data};
};

test('one library with nothing chosen in it offers no choice', () => {
  assert.equal(offersDirectories([entry('a', '')]), false);
});

test('one library lists its folders without a root row, nested by depth', () => {
  const rows = directoryRows([entry('a', ''), entry('a', 'Music'), entry('a', 'Music/Live')]);
  assert.deepEqual(rows.map(row => [row.name, row.depth]), [['Music', 0], ['Live', 1]]);
});

test('several libraries each get a root row and their folders sit under it', () => {
  const entries = [entry('a', ''), entry('a', 'Music'), entry('b', '')];
  assert.equal(offersDirectories(entries), true);
  assert.deepEqual(directoryRows(entries).map(row => [row.name, row.depth]),
    [['a', 0], ['Music', 1], ['b', 0]]);
});

test('an item is in a folder when its id starts with the folder\'s key', () => {
  assert.equal(inDirectory({id: 'a/Music/x.info.json'}, 'a/Music/'), true);
  assert.equal(inDirectory({id: 'a/Music2/x.info.json'}, 'a/Music/'), false);
  assert.equal(inDirectory({id: 'b/x.info.json'}, ''), true);
});

test('the choice is remembered, and clearing it forgets it', () => {
  const storage = memory();
  saveDirectory('a/Music/', storage);
  assert.equal(readDirectory(storage), 'a/Music/');
  saveDirectory('', storage);
  assert.equal(readDirectory(storage), '');
  assert.equal(storage.data[DIRECTORY_KEY], undefined);
  assert.equal(readDirectory({getItem() { throw new Error('blocked'); }}), '');
});
