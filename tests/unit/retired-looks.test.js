// G9 of the Show v3 fixes (2026-11-15): the effect kind only Colour + motion fed (v2.visualizer) goes with its looks
// Visualizer Flow and Visualizer Drift. Saved data naming them is migrated entry by entry before its store validates,
// one warning each; everything else in the file stays as it was and no store is moved aside.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-looks-config-'));
process.env.LIGHTSHOW_CONFIG_DIR = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const { presetById } = await import('../../src/shared/effects/catalogue.ts');
const { HD_MASTER_DEFAULTS } = await import('../../src/shared/effects/types.ts');
const { EffectLibrary } = await import('../../src/server/effect-library.ts');
const { SequenceStore } = await import('../../src/server/sequence-store.ts');
const { PadStore, DEFAULT_PADS } = await import('../../src/server/pads.ts');
const { CueStore } = await import('../../src/server/cues.ts');
const { LookStore } = await import('../../src/server/look-store.ts');
const { Sequencer } = await import('../../src/server/sequencer.ts');
const { SequenceWorkspace } = await import('../../src/server/sequence-workspace.ts');
const { MidiMapStore } = await import('../../src/server/midi-map.ts');

const json = (value) => JSON.parse(JSON.stringify(value));
const KEPT = json(presetById('v2.chase').spec);
const RETIRED = { kind: 'v2.visualizer', params: { profile: 'orbit', space: 'room' } };
const macro = (...effects) => ({ kind: 'macro', params: { loopBeats: 4 * effects.length, steps: effects.map((effect) => ({ effect, beats: 4 })) } });
const MIXED = macro(KEPT, macro(KEPT, RETIRED));

/** A store's file written as given, and the warnings, the file and the directory to read after it loads. */
function scene(t, name, document) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-looks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(document, null, 2));
  const warned = [];
  t.mock.method(console, 'warn', (line) => warned.push(String(line)));
  return { file, warned, saved: () => JSON.parse(fs.readFileSync(file, 'utf8')), beside: () => fs.readdirSync(dir) };
}

/** The same store loaded from a file of only the kept entries: the migration must leave those exactly so. */
function clean(t, name, document, load) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-looks-clean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, name), JSON.stringify(document));
  return load(path.join(dir, name));
}

/** How many warnings name each of `names`: one each. */
const naming = (warned, names) => names.map((name) => warned.filter((line) => line.includes(name)).length);

const pads = (retired) => json(DEFAULT_PADS).map((pad, i) => retired[i] ? { ...pad, label: 'Flow pad', content: { kind: 'preset', id: retired[i] } } : pad);
const emptied = (pad) => ({ ...pad, label: '', content: null });

test('the effect library: a saved look playing the retired kind, itself or in a nested macro, leaves; the rest stays', (t) => {
  const at = '2026-11-01T00:00:00.000Z';
  const look = (id, name, spec) => ({ id, name, spec, createdAt: at, updatedAt: at });
  const kept = [look('user.keep', 'Keep me', KEPT), look('user.macro', 'Kept macro', macro(KEPT, KEPT))];
  const document = { version: 4, presets: [kept[0], look('user.flow', 'My flow', RETIRED), kept[1], look('user.mixed', 'Mixed macro', MIXED)] };
  const { file, warned, saved, beside } = scene(t, 'effects.json', document);
  const library = new EffectLibrary(file).load();
  assert.deepEqual(library.list().user.map((p) => p.id), ['user.keep', 'user.macro']);
  assert.deepEqual(library.list().user, clean(t, 'effects.json', { version: 4, presets: kept }, (f) => new EffectLibrary(f).load()).list().user);
  assert.deepEqual(naming(warned, ['My flow', 'Mixed macro']), [1, 1], warned.join('\n'));
  assert.equal(warned.length, 2, warned.join('\n'));
  assert.deepEqual(saved(), { version: 4, presets: kept }, 'the file loses the two looks and nothing else');
  assert.deepEqual(beside(), ['effects.json'], 'nothing moved aside');
});

test('sequences: a clip naming a retired look or playing the kind, inline or in a nested macro, leaves; groups, pads, patterns and layouts follow', (t) => {
  const lanes = [{ id: 'a', kind: 'shared' }];
  const clip = (id, startBeat, play, name) => ({ id, ...(name ? { name } : {}), laneId: 'a', startBeat, lengthBeats: 8, ...play });
  const keptClips = [clip('k1', 0, { presetId: 'v2.chase' }), clip('k2', 32, { effect: KEPT }), clip('k3', 40, { effect: macro(KEPT, KEPT) })];
  const night = {
    id: 'night', name: 'Night', lanes,
    clips: [keptClips[0], clip('r1', 8, { presetId: 'v2.visualizerFlow' }, 'Flow clip'), clip('r2', 16, { effect: RETIRED }, 'Inline clip'),
      clip('r3', 24, { effect: MIXED }, 'Nested clip'), keptClips[1], keptClips[2]],
    clipGroups: [{ id: 'g1', clipIds: ['k1', 'r1'] }, { id: 'g2', clipIds: ['k2', 'k3', 'r2'] }],
    performance: { master: { ...HD_MASTER_DEFAULTS }, pads: pads({ 9: 'v2.visualizerDrift' }), activePadLayoutId: null },
  };
  const untouched = { id: 'calm', name: 'Calm', lanes, clips: [clip('c1', 0, { presetId: 'v2.visualizerFlowing' })] };
  const keptPatternClip = { startBeat: 4, lengthBeats: 4, presetId: 'v2.chase' };
  const pattern = { id: 'p1', name: 'Pattern', lengthBeats: 8, lanes: [{ kind: 'shared', slot: 0, clips: [
    { name: 'Pattern flow', startBeat: 0, lengthBeats: 4, presetId: 'v2.visualizerFlow.2d' }, keptPatternClip] }] };
  const layoutPads = pads({ 3: 'v2.visualizerDrift.2d' }).map(({ targets: _targets, ...pad }) => ({ ...pad, targetSlots: 'shared' }));
  const layout = { id: 'l1', name: 'Layout', pads: layoutPads, fixtureLabels: [] };
  const document = { version: 1, sequences: [night, untouched], patterns: [pattern], padLayouts: [layout] };
  const { file, warned, saved, beside } = scene(t, 'sequences.json', document);

  const store = new SequenceStore(file).load();
  const expected = {
    version: 1,
    sequences: [{ ...night, clips: keptClips, clipGroups: [{ id: 'g2', clipIds: ['k2', 'k3'] }],
      performance: { ...night.performance, pads: night.performance.pads.map((pad, i) => i === 9 ? emptied(pad) : pad) } }, untouched],
    patterns: [{ ...pattern, lanes: [{ ...pattern.lanes[0], clips: [keptPatternClip] }] }],
    padLayouts: [{ ...layout, pads: layoutPads.map((pad, i) => i === 3 ? emptied(pad) : pad) }],
  };
  assert.deepEqual(saved(), expected, 'only the retired entries change');
  assert.deepEqual(beside(), ['sequences.json'], 'nothing moved aside');
  const reference = clean(t, 'sequences.json', expected, (f) => new SequenceStore(f).load());
  assert.deepEqual(store.list(), reference.list());
  assert.deepEqual(store.listPatterns(), reference.listPatterns());
  assert.deepEqual(store.padLayouts(), reference.padLayouts());
  assert.deepEqual(store.get('night').clips.map((c) => c.id), ['k1', 'k2', 'k3']);
  assert.equal(store.get('night').performance.pads[9].content, null);
  assert.deepEqual(naming(warned, ['Flow clip', 'Inline clip', 'Nested clip', 'Pattern flow']), [1, 1, 1, 1], warned.join('\n'));
  assert.equal(warned.length, 6, `three clips, a pattern clip, a performance pad and a layout pad:\n${warned.join('\n')}`);
});

test('pads: a pad holding a retired look is emptied; the others stay', (t) => {
  const document = { pads: pads({ 2: 'v2.visualizerFlow', 12: 'v2.visualizerDrift' }), activeLayoutId: null };
  const { file, warned, saved, beside } = scene(t, 'pads.json', document);
  const store = new PadStore(file).load();
  const expected = { ...document, pads: document.pads.map((pad, i) => [2, 12].includes(i) ? emptied(pad) : pad) };
  assert.deepEqual(saved(), expected);
  assert.deepEqual(store.layout(), clean(t, 'pads.json', expected, (f) => new PadStore(f).load()).layout());
  assert.deepEqual(store.layout().map((pad) => pad.content?.id ?? null), expected.pads.map((pad) => pad.content?.id ?? null));
  assert.equal(warned.length, 2, warned.join('\n'));
  assert.deepEqual(beside(), ['pads.json']);
});

const look = (pattern, extra = {}) => ({
  bpm: 128, beatDivision: 2, pattern, colorA: 3, colorB: 5, colorC: 1, colorD: 7, masterDimmer: 200, masterBlackout: false,
  strobeSpeed: 0, strobeFunction: 'standard', energyOverride: null, overrides: [], ...extra,
});

test('cues: a cue whose look plays a retired look plays the default look, every other field kept', (t) => {
  const at = '2026-11-01T00:00:00.000Z';
  const cue = (id, name, l) => ({ id, name, createdAt: at, updatedAt: at, look: l });
  const colours = { pattern: 'v2.visualizerFlow', palette: { colours: ['#FF0000', '#0000FF'] } };
  const document = { cues: [
    cue('a', 'Kept cue', look('v2.chase', { effectColours: { pattern: 'v2.chase', mode: 'solid' } })),
    cue('b', 'Flow cue', look('v2.visualizerFlow', { effectColours: colours })),
    cue('c', 'Drift cue', look('v2.visualizerDrift.2d')),
  ] };
  const { file, warned, saved, beside } = scene(t, 'cues.json', json(document));
  const store = new CueStore(file).load();
  const expected = json(document);
  expected.cues[1].look = { ...expected.cues[1].look, pattern: 'chase', effectColours: null };
  expected.cues[2].look = { ...expected.cues[2].look, pattern: 'chase' };
  assert.deepEqual(saved(), expected);
  assert.deepEqual(store.list(), clean(t, 'cues.json', expected, (f) => new CueStore(f).load()).list());
  assert.deepEqual(naming(warned, ['Flow cue', 'Drift cue']), [1, 1], warned.join('\n'));
  assert.equal(warned.length, 2);
  assert.deepEqual(beside(), ['cues.json']);
});

test('the current look: a retired look comes back as the default look, every other field kept', (t) => {
  const document = { savedAt: '2026-11-01T00:00:00.000Z', look: look('v2.visualizerDrift', { running: true }) };
  const { file, warned, saved, beside } = scene(t, 'look.json', document);
  const loaded = new LookStore(file).load();
  const expected = { ...document, look: { ...document.look, pattern: 'chase' } };
  assert.deepEqual(saved(), expected);
  assert.deepEqual(loaded, clean(t, 'look.json', expected, (f) => new LookStore(f).load()));
  assert.equal(warned.length, 1, warned.join('\n'));
  assert.deepEqual(beside(), ['look.json']);
});

test('the sequence workspace: its sequence, baseline and pending take lose the retired entries, and it is not blocked', (t) => {
  const lanes = [{ id: 'a', kind: 'shared', name: '', mute: false, solo: false }];
  const clip = (id, startBeat, play, name) => ({ id, ...(name ? { name } : {}), laneId: 'a', startBeat, lengthBeats: 8, loopBeats: 8, targets: 'lane', mute: false, ...play });
  const sequence = { id: 'night', name: 'Night', mode: 'arrangement', bpm: null, timeSignature: { beats: 4, unit: 4 }, musicMode: null, loop: null, snap: 1,
    lanes, clips: [clip('k1', 0, { presetId: 'v2.chase' }), clip('r1', 8, { effect: RETIRED }, 'Inline clip')], commands: [],
    automation: { tempo: null, brightness: null }, options: { autoplay: true, shuffle: false, randomPaletteOnLoop: false, initialPalette: null } };
  const hit = (presetId) => ({ bank: 0, slot: 1, start: 0, length: 4, targets: 'shared', open: false, presetId });
  const take = { phase: 'review', mode: 'overdub', fromBeat: 0, clockFrom: 0, quantise: 0, sequenceId: 'night', revision: 1,
    take: [hit('v2.chase'), hit('v2.visualizerFlow')] };
  const document = { version: 1, sequence, baseline: sequence, savedSequenceId: 'night', beat: 0, take, takeCompatible: false };
  const { file, warned, saved, beside } = scene(t, 'sequence-workspace.json', document);
  const sequencer = new Sequencer({ resolve: (id) => presetById(id)?.spec ?? null, fixtureIds: () => [1], pad: () => null, admit: () => {} });
  const workspace = new SequenceWorkspace(file, sequencer, () => null).open();
  t.after(() => workspace.close());
  assert.deepEqual(workspace.status().blocked, false, workspace.status().error);
  assert.deepEqual(sequencer.current().clips.map((c) => c.id), ['k1']);
  const kept = { ...sequence, clips: [sequence.clips[0]] };
  assert.deepEqual(saved(), { ...document, sequence: kept, baseline: kept, take: { ...take, take: [take.take[0]] } });
  assert.equal(warned.length, 3, `the clip in the sequence and in its baseline, and the take's hit:\n${warned.join('\n')}`);
  assert.deepEqual(beside(), ['sequence-workspace.json']);
});

test('MIDI: a binding that selects a retired look is unbound; the others stay', (t) => {
  const document = { cc: { 10: { action: 'adjustBpm', type: 'relative', scale: 1 } }, notes: {
    60: { action: 'setPattern', value: 'v2.visualizerFlow' }, 61: { action: 'setPattern', value: 'v2.chase' },
    62: { action: 'setPattern', value: 'v2.visualizerDrift.2d' }, 63: { action: 'energyHold', value: 'energy.blinder' } } };
  const { file, warned, saved, beside } = scene(t, 'midi-map.json', document);
  const store = new MidiMapStore(file).load();
  const expected = { cc: document.cc, notes: { 61: document.notes[61], 63: document.notes[63] } };
  assert.deepEqual(saved(), expected);
  assert.deepEqual(store.get(), clean(t, 'midi-map.json', expected, (f) => new MidiMapStore(f).load()).get());
  assert.deepEqual(naming(warned, ['note 60', 'note 62']), [1, 1], warned.join('\n'));
  assert.equal(warned.length, 2);
  assert.deepEqual(beside(), ['midi-map.json']);
});

// The cue store loads at import, before the library: which saved looks are gone cannot wait for the library to load.
test('a saved look that leaves the library takes every reference to it along, whichever store loads first', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-looks-saved-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const at = '2026-11-01T00:00:00.000Z';
  const preset = (id, name, spec) => ({ id, name, spec, createdAt: at, updatedAt: at });
  write('effects.json', { version: 4, presets: [preset('user.flow', 'My flow', RETIRED), preset('user.keep', 'Keep me', KEPT)] });
  const cue = (id, pattern) => ({ id, name: `Cue ${id}`, createdAt: at, updatedAt: at, look: look(pattern) });
  write('cues.json', { cues: [cue('a', 'user.flow'), cue('b', 'user.keep')] });
  write('look.json', { savedAt: at, look: look('user.flow') });
  write('pads.json', { pads: pads({ 0: 'user.flow', 1: 'user.keep' }), activeLayoutId: null });
  const lanes = [{ id: 'a', kind: 'shared', name: '', mute: false, solo: false }];
  const clip = (id, startBeat, presetId) => ({ id, laneId: 'a', startBeat, lengthBeats: 8, loopBeats: 8, targets: 'lane', mute: false, presetId });
  const night = { id: 'night', name: 'Night', mode: 'arrangement', bpm: null, timeSignature: { beats: 4, unit: 4 }, musicMode: null, loop: null,
    snap: 1, lanes, clips: [clip('f', 0, 'user.flow'), clip('k', 8, 'user.keep')], commands: [], automation: { tempo: null, brightness: null },
    options: { autoplay: true, shuffle: false, randomPaletteOnLoop: false, initialPalette: null } };
  write('sequences.json', { version: 1, sequences: [night] });
  write('sequence-workspace.json', { version: 1, sequence: night, baseline: night, savedSequenceId: 'night', beat: 0, take: null, takeCompatible: false });
  write('midi-map.json', { cc: {}, notes: { 60: { action: 'setPattern', value: 'user.flow' }, 61: { action: 'setPattern', value: 'user.keep' } } });
  const warned = [];
  t.mock.method(console, 'warn', (line) => warned.push(String(line)));

  const cues = new CueStore(path.join(dir, 'cues.json')).load();
  const library = new EffectLibrary(path.join(dir, 'effects.json')).load();
  const padStore = new PadStore(path.join(dir, 'pads.json')).load();
  const sequences = new SequenceStore(path.join(dir, 'sequences.json')).load();
  const sequencer = new Sequencer({ resolve: (id) => library.resolve(id), fixtureIds: () => [1], pad: () => null, admit: () => {} });
  const workspace = new SequenceWorkspace(path.join(dir, 'sequence-workspace.json'), sequencer, (id) => sequences.get(id)).open();
  t.after(() => workspace.close());
  const kept = new LookStore(path.join(dir, 'look.json')).load();
  const midi = new MidiMapStore(path.join(dir, 'midi-map.json')).load();

  assert.deepEqual(library.list().user.map((p) => p.id), ['user.keep']);
  assert.deepEqual(cues.list().map((c) => c.look.pattern), ['chase', 'user.keep']);
  assert.equal(kept.look.pattern, 'chase');
  assert.deepEqual(padStore.layout().slice(0, 2).map((pad) => pad.content?.id ?? null), [null, 'user.keep']);
  assert.deepEqual(sequences.get('night').clips.map((c) => c.id), ['k']);
  assert.equal(workspace.status().blocked, false, workspace.status().error);
  assert.deepEqual(sequencer.current().clips.map((c) => c.id), ['k']);
  assert.doesNotThrow(() => sequencer.load(sequences.get('night')), 'the saved sequence loads');
  assert.deepEqual(Object.keys(midi.get().notes), ['61']);
  assert.deepEqual(read('sequence-workspace.json').sequence.clips.map((c) => c.id), ['k']);
  assert.equal(warned.filter((line) => line.includes('user.flow') || line.includes('My flow')).length, 8,
    `the look, a cue, the restart look, a pad, the sequence's clip, the workspace's two copies, a MIDI note:\n${warned.join('\n')}`);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.invalid-') || name.includes('.recovery-')).length, 0, 'nothing moved aside');
});
