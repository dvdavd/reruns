import assert from 'node:assert/strict';
import test from 'node:test';
import {ArchiveMediaProvider, continuingSubtitleLine, nextSubtitleWordTime, slideSubtitleRows, subtitleContentAt, subtitleRows, subtitleDockTarget,
        visibleSubtitleCues} from '../web/media-provider.js';
import {applyPlaybackPositions, positionKey} from '../web/playback-position.js';

test('new caption rows share the surviving row slide, including interrupted movement', () => {
  const calls = [];
  const row = top => ({
    getBoundingClientRect: () => ({top}),
    animate(frames, options) { calls.push({top, frames, options}); },
  });
  const older = row(100);
  const newer = row(125);
  slideSubtitleRows([older, newer], new Map([[older, 125]]));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].frames, calls[1].frames);
  assert.equal(calls[0].frames[0].transform, 'translateY(25px)');
  calls.length = 0;
  // An update halfway through the slide starts both rows at the visible offset.
  slideSubtitleRows([older, newer], new Map([[older, 112], [newer, 137]]));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].frames[0].transform, 'translateY(12px)');
  assert.deepEqual(calls[0].frames, calls[1].frames);
  calls.length = 0;
  slideSubtitleRows([newer], new Map());
  slideSubtitleRows([older, newer], new Map([[older, 100]]));
  assert.equal(calls.length, 0);
});

test('rolling caption rows preserve formatting and their identity across cues', () => {
  const doc = {createDocumentFragment: () => node(11)};
  function node(type, data = '', children = []) {
    return {
      nodeType: type, data, childNodes: children, ownerDocument: doc,
      append(child) { this.childNodes.push(child); },
      cloneNode() { return node(type, this.data); },
      get textContent() {
        return type === 3 ? this.data : this.childNodes.map(child => child.textContent).join('');
      },
    };
  }
  const first = subtitleRows(node(11, '', [node(1, '', [node(3, 'First row\nSecond row')])]));
  const next = subtitleRows(node(11, '', [node(3, 'Second row\nThird row')]));
  assert.deepEqual(first.map(row => row.textContent), ['First row', 'Second row']);
  assert.equal(first[1].childNodes[0].nodeType, 1);
  assert.equal(continuingSubtitleLine(new Set(first), next[0].textContent), first[1]);
  assert.equal(continuingSubtitleLine(new Set(first), next[1].textContent), undefined);
});

test('rolling captions preserve lines across replacement cues and new words', () => {
  const short = {textContent: 'Hello'};
  const full = {textContent: 'Hello and welcome'};
  const lines = new Set([short, full]);
  assert.equal(continuingSubtitleLine(lines, 'Hello and welcome'), full);
  assert.equal(continuingSubtitleLine(lines, 'Hello and welcome\nback'), full);
  assert.equal(continuingSubtitleLine(lines, 'Different speech'), undefined);
  assert.equal(continuingSubtitleLine(lines, 'Hello there'), short);
  assert.equal(continuingSubtitleLine(lines, 'Hellothere'), undefined);
  lines.delete(full);
  assert.equal(continuingSubtitleLine(lines, 'Hello and welcome'), short);
});

test('positions survive provider recreation, stay per video, and clear on completion', async () => {
  const values = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }});
  try {
    const item = {id: 'one', sourceRef: '/one.mp4', durationSeconds: 120};
    const provider = new ArchiveMediaProvider();
    const source = await provider.resolve(item);
    source.video = {readyState: 1, ended: false};
    const report = {item, source, positionSeconds: 42, durationSeconds: 120, reason: 'pause'};
    provider.reportPlayback(report);
    assert.equal((await new ArchiveMediaProvider().resolve(item)).resumeSeconds, 42);
    assert.equal((await provider.resolve({...item, id: 'two'})).resumeSeconds, 0);
    source.video.readyState = 0;
    provider.reportPlayback({...report, positionSeconds: 0, reason: 'close'});
    assert.equal((await provider.resolve(item)).resumeSeconds, 42);
    source.video.readyState = 1;
    provider.reportPlayback({...report, positionSeconds: 120, reason: 'ended'});
    provider.reportPlayback({...report, positionSeconds: 120, reason: 'close'});
    assert.equal((await provider.resolve(item)).resumeSeconds, 0);
    for (const [position, expected] of [[9.9, 0], [10, 10], [110, 110], [110.1, 0]]) {
      provider.reportPlayback({...report, positionSeconds: position});
      assert.equal((await provider.resolve(item)).resumeSeconds, expected);
      assert.equal(values.has(positionKey(item)), expected > 0);
      // Previously saved positions follow the same rule when loaded for cards.
      values.set(positionKey(item), String(position));
      applyPlaybackPositions(item);
      assert.equal(item.watch.resumeSeconds, expected);
      assert.equal(item.watch.progress, expected / 120 * 100);
      assert.equal(values.has(positionKey(item)), expected > 0);
    }
    globalThis.localStorage.getItem = () => 'NaN';
    assert.equal((await provider.resolve(item)).resumeSeconds, 0);
    globalThis.localStorage.getItem = () => { throw new Error('blocked'); };
    globalThis.localStorage.setItem = () => { throw new Error('full'); };
    assert.equal((await provider.resolve(item)).resumeSeconds, 0);
    assert.doesNotThrow(() => provider.reportPlayback(report));
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('the bottom subtitle dock hit area follows the control-bar clearance', () => {
  const player = {left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500};
  // With the bar up the placeholder is 20px above controls at 440px: its
  // 40px-high box begins at 380px, not at the player bottom.
  const barShown = 80;
  const atVisualBottomDock = {left: 300, top: 380, width: 200, height: 40};
  assert.equal(subtitleDockTarget(player, atVisualBottomDock, barShown), 'bottom');
  const atPhysicalBottom = {...atVisualBottomDock, top: 460};
  assert.equal(subtitleDockTarget(player, atPhysicalBottom, barShown), null);
  const outsideDockZone = {...atVisualBottomDock, top: 200};
  assert.equal(subtitleDockTarget(player, outsideDockZone, barShown), null);
});

test('the bottom subtitle dock hit area drops with the bar when it hides', () => {
  const player = {left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500};
  const barHidden = 20;
  const atPhysicalBottom = {left: 300, top: 440, width: 200, height: 40};
  assert.equal(subtitleDockTarget(player, atPhysicalBottom, barHidden), 'bottom');
  // Where the raised dock would have been is now too far above it.
  const whereTheRaisedDockWas = {...atPhysicalBottom, top: 360};
  assert.equal(subtitleDockTarget(player, whereTheRaisedDockWas, barHidden), null);
});

test('a subtitle clears at its end even when a track still reports it active', () => {
  const first = {startTime: 1, endTime: 2};
  const second = {startTime: 4, endTime: 5};
  const tracks = [
    {mode: 'hidden', activeCues: [first, second]},
    {mode: 'disabled', activeCues: [{startTime: 0, endTime: 10}]},
  ];
  assert.deepEqual(visibleSubtitleCues(tracks, 1.5), [first]);
  assert.deepEqual(visibleSubtitleCues(tracks, 2), []);
  assert.deepEqual(visibleSubtitleCues(tracks, 3), []);
  assert.deepEqual(visibleSubtitleCues(tracks, 4), [second]);
  assert.deepEqual(visibleSubtitleCues(tracks, 5), []);
});

test('timestamped caption words appear as their times arrive', () => {
  const document = {createDocumentFragment: () => node(11)};
  function node(type, value = '', children = []) {
    return {
      nodeType: type, data: value, target: type === 7 ? 'timestamp' : undefined,
      ownerDocument: document, childNodes: children,
      append(child) { this.childNodes.push(child); },
      hasChildNodes() { return this.childNodes.length > 0; },
      cloneNode(deep) { return node(type, value, deep ? children.map(child => child.cloneNode(true)) : []); },
      get textContent() { return type === 3 ? value : this.childNodes.map(child => child.textContent).join(''); },
    };
  }
  const cue = {getCueAsHTML: () => node(11, '', [
    node(3, 'Hello'),
    node(7, '00:00:00.440'), node(1, '', [node(3, ' and')]),
    node(7, '00:00:00.720'), node(1, '', [node(3, ' welcome')]),
  ])};
  assert.equal(subtitleContentAt(cue, 0.3).textContent, 'Hello');
  assert.equal(subtitleContentAt(cue, 0.5).textContent, 'Hello and');
  assert.equal(subtitleContentAt(cue, 0.8).textContent, 'Hello and welcome');
  const timedCue = {text: 'Hello<00:00:00.440><c> and</c><00:00:00.720><c> welcome</c>',
    endTime: 2};
  assert.equal(nextSubtitleWordTime([timedCue], 0.3), 0.44);
  assert.equal(nextSubtitleWordTime([timedCue], 0.5), 0.72);
  assert.equal(nextSubtitleWordTime([timedCue], 0.8), Infinity);
});
