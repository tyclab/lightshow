// The Compare panel, rendered in Node as components.test.js does: what it lists, what its keys
// do, that playing sets the main effect as the picker does and that disarmed it plays nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = path.join(import.meta.dirname, '..', '..');

async function load() {
  const result = await esbuild.build({
    stdin: {
      contents: `
        export { render as html } from 'preact-render-to-string';
        export { h } from 'preact';
        export { store, librarySig } from './public-src/state.js';
        export { CHOICES, CompareList, ComparePanel, compareKey, compareRows, currentPair, diffText, flipSide, playSide, playingSide } from './public-src/components/Compare.jsx';
        export { Effects } from './public-src/components/Effects.jsx';
        export { effectName } from './public-src/now-playing.js';
      `,
      resolveDir: ROOT,
      loader: 'js',
    },
    bundle: true, format: 'esm', platform: 'node', write: false, jsx: 'automatic', jsxImportSource: 'preact',
    loader: { '.js': 'jsx' },
    alias: { 'socket.io-client': path.join(ROOT, 'tests', 'helpers', 'fake-socket-io.js') },
    logLevel: 'silent',
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-panel-')), 'bundle.mjs');
  fs.writeFileSync(file, result.outputFiles[0].text);
  return import(file);
}

const ui = await load();

const side = (pattern, name, rapidFlash = false) => ({ pattern, name, rapidFlash });
const PAIRS = [
  { key: 'one', family: 'Wash', reason: 'duplicate', a: { id: 'solid' }, b: { id: 'v2.wash' },
    diff: { maxChannel: 194, meanAbs: 12.34, framesDiffering: 23, frames: 25 }, play: { a: side('solid', 'Solid'), b: side('v2.wash', 'Wash') } },
  { key: 'two', family: 'Scatter', reason: 'migration', a: { id: 'flashes' }, b: { kind: 'v2.scatter', params: {}, name: 'Scatter' },
    note: 'B is the v2 scatter', play: { a: side('flashes', 'Flashes'), b: side('ab:two:b', 'Scatter', true) } },
  { key: 'three', family: 'Chase', reason: 'duplicate', a: { id: 'chase' }, b: { id: 'v2.chase' },
    play: { a: side('chase', 'Chase →'), b: side('v2.chase', 'Chase') } },
];
const DECISIONS = { one: { choice: 'b', note: 'softer', at: '2026-11-09T12:00:00.000Z' } };
const ready = { status: 'ready', candidates: PAIRS, decisions: DECISIONS };
const keyOf = (html) => [...html.matchAll(/class="ab-pair[^"]*" data-key="([^"]+)"/g)].map((m) => m[1]);

test('pending pairs come first in the order they ship, decided pairs after with their choice', () => {
  const { pending, decided } = ui.compareRows(PAIRS, DECISIONS);
  assert.deepEqual(pending.map((r) => r.key), ['two', 'three']);
  assert.deepEqual(decided.map((r) => [r.key, r.decision.choice]), [['one', 'b']]);
  const html = ui.html(ui.h(ui.CompareList, { data: ready, armed: true, pattern: 'flashes', currentKey: 'two' }));
  assert.deepEqual(keyOf(html), ['two', 'three', 'one']);
  assert.match(html, /To decide <span class="effects-list-count">2<\/span>/);
  assert.match(html, /Decided <span class="effects-list-count">1<\/span>/);
  assert.match(html, /Decided: Keep B — softer/);
  assert.match(html, /Largest channel difference 194 of 255 · mean 12\.3 · 23 of 25 frames differ/);
  assert.match(html, /B is the v2 scatter/);
  assert.match(html, /class="ab-pair current" data-key="two" aria-current="true"/);
  assert.match(html, /data-side="a" aria-pressed="true"/, 'the side on stage is marked');
  assert.equal(html.split('data-choice=').length - 1, 12, 'four choices on every pair, the decided one too');
  assert.match(html, /class="btn sm active" data-choice="b" aria-pressed="true">Keep B</);
  assert.deepEqual(ui.CHOICES.map((c) => c.id), ['a', 'b', 'both', 'neither']);
});

test('disarmed, the panel says the rig must be armed, its play buttons are off and playing sends nothing', () => {
  ui.store.applySnapshot({ versions: {}, state: { armed: false, pattern: 'solid', safety: {} } });
  const panel = ui.html(ui.h(ui.ComparePanel, { onClose: () => {} }));
  assert.match(panel, /The rig must be armed to see A and B/);
  assert.match(panel, /role="dialog"/);
  const list = ui.html(ui.h(ui.CompareList, { data: ready, armed: false, pattern: null, currentKey: null }));
  assert.equal(list.split('class="btn ab-play" data-side').length - 1, 6);
  assert.equal(list.split(/ disabled(?:="")?[ >]/).length - 1, 6, 'every play button is off');
  const played = [];
  assert.equal(ui.playSide(PAIRS[0], 'a', { armed: false, acknowledged: true, play: (p) => played.push(p) }), false);
  assert.deepEqual(played, []);
  ui.store.applySnapshot({ versions: {}, state: { armed: true, pattern: 'solid', safety: {} } });
  assert.doesNotMatch(ui.html(ui.h(ui.ComparePanel, { onClose: () => {} })), /must be armed/);
});

test('playing a side sets the main effect by its pattern id, and a rapid flash asks first until acknowledged', () => {
  const played = [], asked = [];
  const opts = (acknowledged) => ({ armed: true, acknowledged, play: (p) => { played.push(p); return true; }, ask: (q) => asked.push(q) });
  assert.equal(ui.playSide(PAIRS[0], 'b', opts(false)), true);
  assert.equal(ui.playSide(PAIRS[1], 'b', opts(false)), false);
  assert.deepEqual(played, ['v2.wash']);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].name, 'Scatter');
  asked[0].run();
  assert.deepEqual(played, ['v2.wash', 'ab:two:b']);
  ui.playSide(PAIRS[1], 'b', opts(true));
  assert.deepEqual(played, ['v2.wash', 'ab:two:b', 'ab:two:b']);
});

test('A and B play a side, Space swaps, and keys typed into a field or with a modifier are left alone', () => {
  const key = (k, extra = {}) => ui.compareKey({ key: k, code: k === ' ' ? 'Space' : `Key${k.toUpperCase()}`, target: { tagName: 'BUTTON' }, ...extra });
  assert.equal(key('a'), 'a');
  assert.equal(key('B'), 'b');
  assert.equal(key(' '), 'flip');
  assert.equal(key('c'), null);
  assert.equal(key('a', { target: { tagName: 'INPUT' } }), null);
  assert.equal(key(' ', { target: { tagName: 'TEXTAREA' } }), null);
  assert.equal(key('a', { ctrlKey: true }), null);
  assert.equal(key('b', { repeat: true }), null);
  assert.equal(ui.flipSide('a'), 'b');
  assert.equal(ui.flipSide('b'), 'a');
  assert.equal(ui.flipSide(null), 'a', 'from neither side, A first');
  assert.equal(ui.playingSide(PAIRS[1], 'ab:two:b'), 'b');
  assert.equal(ui.playingSide(PAIRS[1], 'solid'), null);
  assert.equal(ui.currentPair(ready, null).key, 'two', 'the keys act on the first pending pair');
  assert.equal(ui.currentPair(ready, 'one').key, 'one', 'or on the pair last played');
  assert.equal(ui.currentPair({ candidates: [], decisions: {} }, null), null);
});

test('the Effects view opens the panel beside its title, which stays the title alone, and an unknown ab: id shows as it is', () => {
  ui.store.applySnapshot({ versions: {}, state: { armed: false, pattern: 'solid', patterns: [], effects: [], safety: {} } });
  const html = ui.html(ui.h(ui.Effects, {}));
  assert.match(html, /<div class="effects-head"><div class="card-title">Effects<\/div><button type="button" class="btn sm effects-compare" aria-haspopup="dialog"[^>]*>Compare A\/B<\/button>/);
  assert.doesNotMatch(/<div class="effects-tools">(.*?)<\/div>/s.exec(html)[1], /effects-compare/, 'not in the sticky tools, which must stay short on a phone');
  assert.equal(ui.effectName('ab:none:b', {}), 'ab:none:b', 'an unknown ab: id shows as it is');
});
