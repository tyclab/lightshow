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
  assert.deepEqual(playingState(s).base, { id: 'mine', name: s.effects[0].name, running: true, frozen: false });
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
  assert.match(nowPlaying({ pattern: 'chase', running: true, control: { frozen: true } }), /^Main effect: [^·]* \(frozen\)/);
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
  assert.equal(layerText({ pattern: 'chase', running: true, control: { frozen: true } })[1], 'Main effect: Chase (frozen)');
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

test('pads and overrides name each thing playing over the main effect once', () => {
  assert.equal(above({ voices: [{ id: 'v', label: 'Blinder' }, { id: 'h', label: 'Hidden', hidden: true }] }), 'Pads and overrides: Blinder');
  const activeClips = [{ id: 'c1', laneId: 'a', lane: 'Front', name: 'Pulse' }, { id: 'c2', laneId: 'b', lane: 'Back', name: 'Wave' }];
  assert.equal(above({ sequence: { ...sequence, playing: true, activeClips } }), 'Pads and overrides: Front: Pulse, Back: Wave');
  // A strobe or a matrix launched as a voice is that voice, not a second layer.
  assert.equal(above({ strobe: { active: 'pad' } }), 'Pads and overrides: Strobe');
  assert.equal(above({ strobe: { active: 'pad' }, voices: [{ id: 's', label: 'Strobe pad', tier: 'strobe' }] }), 'Pads and overrides: Strobe pad');
  assert.equal(above({ matrix: { colours: ['#FF0000'], mode: 'fills', voice: 'm' }, voices: [{ id: 'm', label: 'Matrix', source: 'matrix' }] }), 'Pads and overrides: Matrix');
  assert.equal(above({ paletteOverride: ['#112233'] }), 'Pads and overrides: Palette override');
  for (const quiet of [{ voices: [] }, { strobe: { active: null } }, { matrix: { colours: [] } }, { paletteOverride: [] }]) {
    assert.equal(above(quiet), 'Pads and overrides: None active');
  }
});

// As the renderer decides it: a fixture's blackout gates it whether or not its colour override is on.
test('a fixture override or blackout counts, a disabled override without blackout does not', () => {
  const fixtures = [
    { id: 1, label: 'Par 1', override: { enabled: true, blackout: false } },
    { id: 2, label: 'Par 2', override: { enabled: false, blackout: true } },
    { id: 3, label: 'Bar 1', override: { enabled: false, blackout: false } },
  ];
  assert.equal(above({ fixtures }), 'Pads and overrides: Par 1 override, Par 2 blackout');
  assert.equal(above({ fixtures: [{ ...fixtures[0], override: { enabled: true, blackout: true } }] }), 'Pads and overrides: Par 1 blackout');
});

// Stopped on Hold or Black, the sequence lists no clips, yet the renderer keeps or cuts its frame.
test('a stopped sequence that holds its frame or blacks out counts; one that ended does not', () => {
  assert.equal(above({ sequence: { ...sequence, stopped: 'hold' } }), 'Pads and overrides: Sequence Intro (holding frame)');
  assert.equal(above({ sequence: { ...sequence, stopped: 'black' } }), 'Pads and overrides: Sequence Intro (blackout)');
  for (const flags of [{ ended: true }, {}, { playing: true }]) assert.equal(above({ sequence: { ...sequence, ...flags } }), 'Pads and overrides: None active');
});

// The board keeps its colours while its voice is stopped (the acknowledgement taken back): nothing plays.
test('the Matrix counts only while its voice plays, in the strip and the shared status', () => {
  const held = { colours: ['#FF0000'], mode: 'fills', voice: null };
  assert.equal(above({ matrix: held }), 'Pads and overrides: None active');
  assert.doesNotMatch(nowPlaying({ matrix: held }), /Matrix/);
  assert.equal(above({ matrix: { ...held, voice: 'voice:9' } }), 'Pads and overrides: Matrix');
  assert.match(nowPlaying({ matrix: { ...held, voice: 'voice:9' } }), /Matrix: 1 colour as fills/);
});

test('a long list shows the first names and how many more, the full list in the title', () => {
  const voices = ['Blinder', 'Kill', 'UV', 'Glow', 'Domino'].map((label, i) => ({ id: String(i), label }));
  assert.equal(above({ voices }), 'Pads and overrides: Blinder, Kill, UV +2 more');
  assert.equal(pictureLayers({ voices }).at(0).title, 'Blinder, Kill, UV, Glow, Domino');
  const long = [{ id: 'a', label: 'A long voice label from a pad bank' }, { id: 'b', label: 'Second long voice label' }];
  assert.equal(above({ voices: long }), 'Pads and overrides: A long voice label from a pad bank +1 more', 'the first name always shows');
});

test('a stopped main effect reads as stopped and is not frozen: the two states are independent', () => {
  assert.match(nowPlaying({ pattern: 'chase', running: false }), /^Main effect: [^·]* \(stopped\)/);
  assert.doesNotMatch(nowPlaying({ pattern: 'chase', running: false }), /frozen/);
  assert.match(nowPlaying({ pattern: 'chase', running: false, control: { frozen: true } }), /^Main effect: [^·]* \(stopped\) \(frozen\)/);
});
