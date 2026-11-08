// The gallery keeps one spacer per run of unmounted chunks. These pin that
// reconcileSpacers only adds, moves or drops spacers, and never moves a chunk
// node that is already in place, since that would restart its thumbnails.
import assert from 'node:assert/strict';
import test from 'node:test';
import {reconcileSpacers} from '../shared/components/VirtualGallery.js';

class FakeNode {
  constructor(name, spacer = false) {
    this.name = name;
    this.parentNode = null;
    this.style = {height: ''};
    this.classList = {contains: value => spacer && value === 'gallery-spacer'};
  }
  get nextSibling() {
    const siblings = this.parentNode?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
}

class FakeRoot {
  constructor() {
    this.children = [];
    this.moved = [];
  }
  get firstChild() { return this.children[0] || null; }
  insertBefore(node, before) {
    if (node.parentNode === this) this.moved.push(node.name);
    node.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, node);
    node.parentNode = this;
  }
}

function run(root, wanted) {
  let made = 0;
  reconcileSpacers(root, wanted, () => new FakeNode(`new${++made}`, true));
  return root.children.map(node => node.classList.contains('gallery-spacer')
    ? `spacer ${node.style.height}` : node.name);
}

test('an empty gallery gets one spacer for everything', () => {
  const root = new FakeRoot();
  assert.deepEqual(run(root, [1200]), ['spacer 1200px']);
});

test('a chunk mounted in the middle splits the spacer around it', () => {
  const root = new FakeRoot();
  run(root, [1200]);
  const chunk = new FakeNode('chunk');
  root.insertBefore(chunk, null);
  root.moved = [];
  assert.deepEqual(run(root, [500, chunk, 600]), ['spacer 500px', 'chunk', 'spacer 600px']);
  assert.deepEqual(root.moved, []);
});

test('chunks already in place stay put while the spacers between them change', () => {
  const root = new FakeRoot();
  const first = new FakeNode('first');
  const second = new FakeNode('second');
  run(root, [100, first, 200, second, 300]);
  root.moved = [];
  // `first` dropped, and a new chunk placed before `second`.
  first.remove();
  const middle = new FakeNode('middle');
  root.insertBefore(middle, second);
  root.moved = [];
  assert.deepEqual(run(root, [350, middle, second, 300]),
                   ['spacer 350px', 'middle', 'second', 'spacer 300px']);
  assert.deepEqual(root.moved, []);
});

test('spacers are reused rather than made again', () => {
  const root = new FakeRoot();
  const chunk = new FakeNode('chunk');
  run(root, [100, chunk, 200]);
  const spacers = root.children.filter(node => node !== chunk);
  chunk.remove();
  assert.deepEqual(run(root, [400]), ['spacer 400px']);
  assert.ok(spacers.includes(root.children[0]));
});

test('a chunk node not yet in the grid is put where it belongs', () => {
  const root = new FakeRoot();
  const before = new FakeNode('before');
  run(root, [before, 900]);
  const after = new FakeNode('after');
  assert.deepEqual(run(root, [before, 100, after, 700]),
                   ['before', 'spacer 100px', 'after', 'spacer 700px']);
});
