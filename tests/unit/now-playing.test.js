import test from 'node:test';
import assert from 'node:assert/strict';
import { effectName, padLabel, playingState } from '../../public-src/now-playing.js';
import { VIEWS, viewShortcut } from '../../public-src/views.js';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { nowPlaying } from '../../public-src/preview-inputs.js';
import { pictureLayers } from '../../public-src/picture-layers.js';
import { DEFAULT_BACKGROUND } from '../../src/shared/background.ts';

const sequence = { loaded: { id: 'intro', name: 'Intro' }, beat: 5.5, bar: 2, beatsPerBar: 3 };

test('status resolves the base name from saved presets first', () => {
  const s = { pattern: 'mine', effects: [{ id: 'mine', name: 'Custom' }], patterns: [{ id: 'mine', name: 'Other' }] };
  assert.deepEqual(playingState(s).base, { id: 'mine', name: s.effects[0].name, running: true });
});

for (const [flags, mode] of [[{ playing: true }, 'playing'], [{ paused: true }, 'paused'], [{ stopped: 'hold' }, 'hold'], [{ stopped: 'black' }, 'black'], [{ ended: true }, 'ended'], [{}, 'loaded']]) {
  test(`status preserves sequence ${mode}`, () => {
    assert.deepEqual(playingState({ sequence: { ...sequence, ...flags } }).sequence, { ...sequence.loaded, mode, beat: 5.5, bar: 2, beatsPerBar: 3, beatSize: 1, activeClips: [] });
  });
}

test('status exposes visible voices from every launch source', () => {
  const voices = ['api', 'midi', 'pad', 'matrix', 'strobe'].map((source, id) => ({ id: String(id), label: source, source }));
  const hidden = { id: 'hidden', label: 'hidden', hidden: true };
  assert.deepEqual(playingState({ voices: [...voices, hidden] }).voices, voices);
});

test('status reports a nonempty palette override', () => {
  assert.equal(playingState({ paletteOverride: ['#112233'] }).override, true);
  for (const paletteOverride of [null, undefined, []]) assert.equal(playingState({ paletteOverride }).override, false);
});

test('empty pad labels use the catalogue name', () => {
  const content = { kind: 'preset', id: 'hd.auroraDrift' };
  assert.equal(padLabel({ label: ' ', content }), presetById(content.id).name);
});

test('custom pad labels take precedence over catalogue names', () => {
  assert.equal(padLabel({ label: 'Mine', content: { kind: 'preset', id: 'hd.auroraDrift' } }), 'Mine');
});

test('missing catalogue entries retain their identifiers', () => {
  assert.equal(effectName('missing'), 'missing');
});

test('every view has a distinct reachable digit shortcut', () => {
  assert.equal(new Set(VIEWS.map((view) => `${!!view.shift}:${view.key}`)).size, VIEWS.length);
  for (const view of VIEWS) {
    assert.equal(viewShortcut({ key: view.shift ? ')' : view.key, code: `Digit${view.key}`, shiftKey: !!view.shift })?.id, view.id);
  }
});

test('view shortcuts respect controls that consumed the digit', () => {
  assert.equal(viewShortcut({ key: '0', defaultPrevented: true }), null);
});

test('view shortcuts leave text input alone', () => {
  assert.equal(viewShortcut({ key: '0', target: { tagName: 'INPUT' } }), null);
});


test('status retains separate pixel look names for patched panels', () => {
  const state = { pixelPattern: 'chase', panelPattern: 'rainbow', fixtures: [{ profileId: 'panel' }], profiles: { panel: { grid: { columns: 2 }, cells: [{}, {}] } } };
  assert.deepEqual(playingState(state).layers.map((layer) => layer.id), ['chase', 'rainbow']);
  assert.deepEqual(playingState({ ...state, fixtures: [] }).layers, []);
});

test('shared status names the clips covering the base look', () => {
  const activeClips = [{ id: 'c1', laneId: 'a', lane: 'Front', name: 'Custom pulse' }];
  const state = { pattern: 'solid', sequence: { ...sequence, playing: true, activeClips } };
  assert.deepEqual(playingState(state).sequence.activeClips, activeClips);
  assert.match(nowPlaying(state), /Clips: Front: Custom pulse/);
});

for (const kind of ['pattern', 'sequencePattern']) {
  test(`empty ${kind} pad labels use the saved pattern name`, () => {
    const sequencePatterns = [{ id: 'p1', name: 'Closing phrase' }];
    assert.equal(padLabel({ label: '', content: { kind, id: 'p1' } }, { sequencePatterns }), 'Closing phrase');
  });
}

test('a frozen main effect reads as frozen, the word its transport button uses', () => {
  assert.match(nowPlaying({ pattern: 'chase', running: false }), /^Main effect: [^·]* \(frozen\)/);
  assert.doesNotMatch(nowPlaying({ pattern: 'chase', running: true }), /frozen|stopped/);
});

// The operator read "Base" as the background: the running look is the main effect, the word the picture layers use.
test('shared status names the running look the main effect', () => {
  const s = { pattern: 'chase', patterns: [{ id: 'chase', name: 'Chase' }] };
  assert.equal(nowPlaying(s), 'Main effect: Chase');
  assert.doesNotMatch(nowPlaying({ ...s, voices: [{ id: 'v', label: 'Blinder' }], paletteOverride: ['#112233'] }), /\bBase\b/);
});

const PATTERNS = [{ id: 'chase', name: 'Chase' }];
const FIXTURES = [{ id: 1, label: 'Par 1' }, { id: 2, label: 'Par 2' }, { id: 3, label: 'Bar 1' }];
const layerText = (s) => pictureLayers({ patterns: PATTERNS, fixtures: FIXTURES, ...s }).map(({ name, value }) => `${name}: ${value}`);
const above = (s) => layerText(s)[0];
const backdrop = (background) => layerText({ background: { ...DEFAULT_BACKGROUND, ...background } })[2];

test('picture layers read top to bottom: what plays over the main effect, the main effect, the background', () => {
  assert.deepEqual(layerText({ pattern: 'chase' }), ['Pads and overrides: None active', 'Main effect: Chase', 'Background: Follow effect · Whole rig']);
  assert.deepEqual(pictureLayers({}).map((layer) => layer.id), ['above', 'main', 'background']);
  assert.equal(layerText({ pattern: 'chase', running: false })[1], 'Main effect: Chase (frozen)');
  assert.equal(layerText({})[1], 'Main effect: No look');
});

test('the background layer names the mode and the fixtures as the Background card does', () => {
  assert.equal(backdrop({ mode: 'fixed' }), 'Background: Fixed colour · Whole rig');
  assert.equal(backdrop({ mode: 'off', fixtures: 'wash' }), 'Background: Off · Wash fixtures');
  // A pick counts the patched fixtures it reaches; an id since removed from the patch reaches none.
  assert.equal(backdrop({ fixtures: 'selected', selected: [3, 1, 99] }), 'Background: Follow effect · Selected (2 of 3)');
  assert.equal(backdrop({ mode: 'fixed', fixtures: 'selected' }), 'Background: Fixed colour · Selected (0 of 3)');
  assert.equal(layerText({ background: null })[2], 'Background: Follow effect · Whole rig', 'before the first state, the default setting');
});

test('pads and overrides count each thing playing over the main effect once', () => {
  assert.equal(above({ voices: [{ id: 'v', label: 'Blinder' }, { id: 'h', label: 'Hidden', hidden: true }] }), 'Pads and overrides: 1 active');
  const activeClips = [{ id: 'c1', laneId: 'a', lane: 'Front', name: 'Pulse' }, { id: 'c2', laneId: 'b', lane: 'Back', name: 'Wave' }];
  assert.equal(above({ sequence: { ...sequence, playing: true, activeClips } }), 'Pads and overrides: 2 active');
  // A strobe or a matrix launched as a voice is that voice, not a second layer.
  assert.equal(above({ strobe: { active: 'pad' } }), 'Pads and overrides: 1 active');
  assert.equal(above({ strobe: { active: 'pad' }, voices: [{ id: 's', label: 'Strobe', tier: 'strobe' }] }), 'Pads and overrides: 1 active');
  assert.equal(above({ matrix: { colours: ['#FF0000'], mode: 'fills' }, voices: [{ id: 'm', label: 'Matrix', source: 'matrix' }] }), 'Pads and overrides: 1 active');
  assert.equal(above({ paletteOverride: ['#112233'] }), 'Pads and overrides: 1 active');
  const overridden = FIXTURES.map((f, i) => ({ ...f, override: { enabled: i < 2, blackout: false } }));
  assert.equal(above({ fixtures: overridden }), 'Pads and overrides: 2 active');
  assert.equal(pictureLayers({ fixtures: overridden, paletteOverride: ['#112233'] })[0].title, 'Palette override, Par 1 override, Par 2 override');
  for (const quiet of [{ voices: [] }, { strobe: { active: null } }, { matrix: { colours: [] } }, { paletteOverride: [] }]) {
    assert.equal(above(quiet), 'Pads and overrides: None active');
  }
});
