// The catalogue's tags (src/shared/effects/tags.ts): what each visible look's code
// reads, where it draws, its colours and its use. The table below pins every look
// the Effects view lists; a new look fails here until it is tagged on purpose.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PATTERNS, PRESET_ROWS } from '../../src/server/presets.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { presetById } from '../../src/shared/effects/index.ts';
import { KINDS, validateSpec } from '../../src/shared/effects/registry.ts';
import { mappingOf, usesSpatialMapping } from '../../src/shared/effects/mapping.ts';
import { LEGACY_TAGGED, REACTIVE_TAGS, SOURCES, TAG_AXES, TAG_NOTES, TAGS, browseListOf, legacyTags, specTags } from '../../src/shared/effects/tags.ts';

// What every registered kind reacts to with its default params, counted per tag.
const KIND_REACTS = { beat: 133, static: 19, bands: 5, level: 2, sections: 0, screen: 1 };

// id: 'tags / sources', in vocabulary order.
const PINNED = {
  solid: 'static rig',
  fade: 'beat rig',
  hit: 'bands rig / track',
  strobe: 'static rig',
  'color-cycle': 'beat rig',
  rainbow: 'beat ownColours',
  chase: 'beat',
  'chase-rev': 'beat',
  'ping-pong': 'beat',
  runner: 'beat',
  pairs: 'beat',
  wave: 'beat',
  'stack-up': 'beat',
  split: 'beat',
  sections: 'beat',
  twinkle: 'beat',
  sparkle: 'beat',
  'random-flash': 'beat',
  ensemble: 'beat',
  ribbon: 'beat',
  gradient: 'beat bars',
  comet: 'beat bars',
  burst: 'beat bars',
  plasma: 'beat bars',
  meter: 'level bars / live',
  drums: 'bands bars / track',
  stems: 'bands bars / track',
  rise: 'beat bars',
  impact: 'bands bars / track',
  bars: 'bands bars / track',
  fire: 'bands bars / track',
  rain: 'bands bars / track',
  'flash-chase': 'beat bars rapid',
  'flash-scatter': 'beat bars rapid',
  'flash-fill': 'beat bars',
  'flash-alternate': 'beat bars rapid',
  ramp: 'beat bars',
  'ramp-scatter': 'beat bars',
  'decay-scatter': 'beat bars',
  'flash-burst': 'beat bars rapid',
  core: 'bands bars rapid / track',
  'position-chase': 'beat',
  'radial-pulse': 'bands / track',
  'spatial-wash': 'beat',
  'bounce-scan': 'beat',
  streak: 'beat',
  starlight: 'beat',
  breathe: 'beat rig',
  'volume-gate': 'level / track',
  confetti: 'bands / track',
  'anchor-fill': 'beat',
  halves: 'beat',
  flip: 'beat',
  'room-wave': 'beat',
  'ring-strobe': 'beat rapid',
  'ring-backlit': 'beat rapid',
  fireworks: 'beat',
  flashes: 'beat',
  swirl: 'beat',
  'party.fire': 'beat ownColours',
  'party.ice': 'beat rig ownColours',
  'energy.whiteStrobe': 'beat rig ownColours energy rapid',
  'energy.colorStrobe': 'beat rig energy rapid',
  'energy.blinder': 'static rig ownColours energy',
  'energy.uvWash': 'static rig ownColours energy',
  'energy.kill': 'static rig ownColours energy',
  'energy.glow': 'static rig energy',
  'palette-strobe': 'beat rig energy rapid',
  'overlay.all': 'beat rig energy rapid',
  'overlay.step': 'beat room energy rapid',
  'overlay.scatter': 'beat room energy rapid',
  'overlay.zone': 'beat room energy rapid',
  'v2.scatterStrobe': 'beat room ownColours rapid',
  'v2.scatterFade': 'beat room',
  'v2.scatterGrow': 'beat room',
  'v2.grooveWave': 'beat room',
  'v2.bigRoomWave': 'beat room',
  'v2.ascent': 'beat room',
  'v2.doubleWave': 'beat room',
  'v2.swagger': 'beat room',
  'v2.impact': 'bands room / live',
  'v2.vortex': 'beat room',
  'v2.speakerShockwave': 'bands room / live',
  'v2.rotation': 'beat room',
  'v2.swirl': 'beat room',
  'v2.beacon': 'beat room',
  'v2.neural': 'bands room / live',
  'v2.neuralDistance': 'bands room / live',
  'v2.beatAccentWash': 'bands room / live',
  'v2.volumeGateWash': 'level room / live',
  'v2.frequencyBurst': 'bands room rapid / live',
  'v2.wash': 'static rig',
  'v2.breathe': 'beat rig',
  'v2.chase': 'beat room',
  'v2.pathRunner': 'beat',
  'v2.surround': 'beat room',
  'v2.zones': 'beat room',
  'v2.surroundAnswer': 'beat room',
  'v2.nearFar': 'beat room',
  'v2.noise': 'beat room',
  'v2.aurora': 'beat room',
  'v2.fire': 'beat room',
  'v2.risingWall': 'sections room / track',
  'v2.fallingWall': 'beat room',
  'v2.lightOrbs': 'beat room',
  'v2.orbCollision': 'sections room / track',
  'v2.fireworks': 'beat room',
  'v2.rain': 'beat room',
  'v2.stemsSpace': 'bands room / track live',
  'v2.visualizerFlow': 'screen room / screen',
  'v2.visualizerDrift': 'screen room / screen',
  'v2.globeSpectrum': 'bands room / live',
  'v2.globePulse': 'level room / live',
};

const VISIBLE = [...PATTERNS, ...PRESET_ROWS].filter((row) => !row.retired);
const pinOf = (row) => `${row.tags.join(' ')}${row.via ? ` / ${row.via.join(' ')}` : ''}`;
const count = (rows, tag) => rows.filter((row) => row.tags.includes(tag)).length;

test('every visible look carries the tags pinned for it, and no look is missing or extra', () => {
  assert.equal(VISIBLE.length, 113);
  assert.deepEqual(VISIBLE.map((row) => row.id).sort(), Object.keys(PINNED).sort(), 'a look added or removed is tagged on purpose');
  for (const row of VISIBLE) assert.equal(pinOf(row), PINNED[row.id], row.id);
});

test('every visible look says what it reacts to, and only a reactive one says where from', () => {
  const reacts = TAG_AXES.find((axis) => axis.id === 'reacts').tags;
  for (const row of VISIBLE) {
    assert.ok(row.tags.length > 0, `${row.id} is untagged`);
    assert.ok(row.tags.some((tag) => reacts.includes(tag)), `${row.id} has no Reacts-to tag`);
    const reactive = row.tags.some((tag) => REACTIVE_TAGS.has(tag));
    assert.equal(!!row.via?.length, reactive, `${row.id}: a source mark exactly when it reacts`);
    assert.ok(row.tags.every((tag) => Object.hasOwn(TAGS, tag)) && (row.via ?? []).every((s) => Object.hasOwn(SOURCES, s)), row.id);
    assert.ok(!(row.tags.includes('beat') && row.tags.includes('static')) && !(reactive && row.tags.some((t) => t === 'beat' || t === 'static')), row.id);
    assert.ok(row.tags.filter((tag) => TAGS[tag].axis === 'surface').length <= 1, `${row.id}: one surface at most`);
  }
});

test('the twelve tags and their counts over the 113 looks', () => {
  assert.deepEqual(TAG_AXES.map((axis) => [axis.name, axis.tags.map((tag) => TAGS[tag].name)]), [
    ['Reacts to', ['Beat only', 'Static', 'Bands & drums', 'Audio level', 'Song sections', 'Screen']],
    ['Surface', ['Whole rig', 'Room-placed', 'Bars & panels']],
    ['Colour', ['Own colours']],
    ['Use & safety', ['Energy', 'Rapid ⚡']],
  ]);
  const counts = Object.fromEntries(Object.keys(TAGS).map((tag) => [tag, count(VISIBLE, tag)]));
  assert.deepEqual(counts, {
    beat: 80, static: 7, bands: 18, level: 4, sections: 2, screen: 2,
    rig: 17, room: 41, bars: 21, ownColours: 8, energy: 11, rapid: 16,
  });
  const reactive = VISIBLE.filter((row) => row.tags.some((tag) => REACTIVE_TAGS.has(tag)));
  assert.equal(reactive.length, 26);
  assert.deepEqual(Object.fromEntries(Object.keys(SOURCES).map((s) => [s, reactive.filter((r) => r.via.includes(s)).length])),
    { track: 14, live: 11, screen: 2 });
});

test('tags restate the fields the server already sends: pixel, room mapping, rapid flash, the energy family', () => {
  for (const row of VISIBLE) {
    assert.equal(row.tags.includes('bars'), !!row.pixel, row.id);
    assert.equal(row.tags.includes('room'), row.mapping === 'room', row.id);
    assert.equal(row.tags.includes('rapid'), !!row.rapidFlash, row.id);
    if (!row.legacy) assert.equal(row.tags.includes('energy'), row.family === 'own.energy', row.id);
  }
});

test('the legacy table covers exactly the legacy patterns', () => {
  const legacy = PATTERNS.map((row) => row.id);
  assert.deepEqual([...LEGACY_TAGGED].sort(), [...legacy].sort());
  assert.deepEqual(legacyTags('no-such-pattern'), { tags: [], via: [] });
});

test('a saved preset is tagged from its kind and params, so an edited copy gets its own tags', () => {
  const of = (raw) => specTags(validateSpec(raw));
  assert.deepEqual(of({ kind: 'v2.wash', params: { colour: 'solid' } }), { tags: ['static', 'rig'], via: [] });
  assert.deepEqual(of({ kind: 'v2.wash', params: { colour: 'time' } }), { tags: ['beat', 'rig'], via: [] }, 'its colour walks the palette on the beat');
  assert.deepEqual(of({ kind: 'v2.wash', params: { colour: 'solid', trigger: { mode: 'beatAccent', band: 'bass' } } }),
    { tags: ['bands', 'rig'], via: ['live'] });
  assert.deepEqual(of({ kind: 'v2.wash', params: { colour: 'solid', trigger: { mode: 'volumeGate', band: 'full' } } }),
    { tags: ['level', 'rig'], via: ['live'] });
  assert.deepEqual(of({ kind: 'v2.sweep', params: { profile: 'fill', fillSource: 'section' } }), { tags: ['sections', 'room'], via: ['track'] });
  assert.deepEqual(of({ kind: 'v2.sweep', params: { profile: 'fill', fillSource: 'section', space: 'plan' } }),
    { tags: ['sections'], via: ['track'] }, 'drawn across the plot: no surface tag');
  assert.deepEqual(of({ kind: 'v2.sweep', params: { fillSource: 'section' } }), { tags: ['beat', 'room'], via: [] }, 'the fill source reads only with the fill profile');
  assert.deepEqual(of({ kind: 'v2.scatter', params: { bands: ['full'] } }), { tags: ['level', 'room'], via: ['live'] });
  assert.deepEqual(of({ kind: 'v2.zones', params: { partition: 'stems' } }), { tags: ['bands', 'room'], via: ['track', 'live'] });
  assert.deepEqual(of({ kind: 'v2.particles', params: { collide: true } }), { tags: ['sections', 'room'], via: ['track'] });
  const strobe = { clock: 'beat', flashesPerSecond: 5, continueBetween: true };
  assert.deepEqual(of({ kind: 'strobe', palette: null, params: { ...strobe, selection: 'scatter', space: 'room' } }),
    { tags: ['beat', 'room', 'energy', 'rapid'], via: [] });
  assert.deepEqual(of({ kind: 'strobe', params: strobe }), { tags: ['beat', 'rig', 'ownColours', 'energy', 'rapid'], via: [] }, 'the kind\'s own white palette');
  assert.deepEqual(of({ kind: 'strobe', palette: null, params: { ...strobe, colourMode: 'white', clock: 'wall' } }),
    { tags: ['static', 'rig', 'ownColours', 'energy', 'rapid'], via: [] }, 'a wall-clock strobe follows its own rate, not the beat');
  // A saved copy of an older party preset keeps its own palette and its timeline; its trigger can make it react.
  const domino = validateSpec({ kind: 'hd.positionChase', palette: ['#FF2BD6', '#7C3AED'] });
  assert.deepEqual(specTags(domino), { tags: ['beat', 'ownColours'], via: [] });
  assert.deepEqual(specTags({ ...domino, palette: null, params: { ...domino.params, trigger: { ...domino.params.trigger, mode: 'beatAccent', band: 'high' } } }),
    { tags: ['bands'], via: ['live'] });
  assert.deepEqual(specTags(presetById('party.ice').spec), { tags: ['beat', 'rig', 'ownColours'], via: [] });
  assert.deepEqual(of({ kind: 'energy.blinder' }), { tags: ['static', 'rig', 'ownColours', 'energy'], via: [] });
  assert.deepEqual(of({ kind: 'energy.glow' }), { tags: ['static', 'rig', 'energy'], via: [] });
});

test('the presets saved here carry their tags in the summaries the browser lists', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effect-tags-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const library = new EffectLibrary(path.join(dir, 'effects.json'));
  library.create({ name: 'Bass wash', spec: { kind: 'v2.wash', params: { colour: 'solid', trigger: { mode: 'beatAccent', band: 'bass' } } } });
  library.create({ name: 'Still wash', spec: { kind: 'v2.wash', params: { colour: 'solid' } } });
  assert.deepEqual(library.summaries().map(({ name, tags, via }) => ({ name, tags, via })), [
    { name: 'Bass wash', tags: ['bands', 'rig'], via: ['live'] },
    { name: 'Still wash', tags: ['static', 'rig'], via: undefined },
  ]);
});

// ── Review round 1 ───────────────────────────────────────────────────────────

test('the show expression is no input tag: ensemble and ribbon, which both read it, are tagged alike', () => {
  assert.deepEqual(legacyTags('ensemble'), legacyTags('ribbon'));
  assert.deepEqual(legacyTags('ensemble'), { tags: ['beat'], via: [] });
});

test('every registered kind says what it reacts to, from its code', () => {
  const reacts = new Set(TAG_AXES.find((axis) => axis.id === 'reacts').tags);
  const counts = Object.fromEntries([...reacts].map((tag) => [tag, 0]));
  for (const [kind, def] of KINDS) {
    const spec = { kind, params: def.defaults.params ?? {}, ...(def.defaults.palette !== undefined ? { palette: def.defaults.palette } : {}) };
    const tags = specTags(spec).tags.filter((tag) => reacts.has(tag));
    assert.ok(tags.length > 0, `${kind} has no Reacts-to tag`);
    for (const tag of tags) counts[tag] = (counts[tag] ?? 0) + 1;
  }
  // A new kind changes these counts, so it is placed on purpose.
  assert.deepEqual(counts, KIND_REACTS);
});

// Version 0 and 1 libraries load their hd/ldj specs as compat.* kinds (migrate.ts); they are the same effect.
test('a compat kind gets the tags and mapping of its plain twin', () => {
  let compared = 0;
  for (const [kind, def] of KINDS) {
    if (!/^(hd|ldj)\./.test(kind)) continue;
    const plain = { kind, params: def.defaults.params };
    const compat = { ...plain, kind: `compat.${kind}` };
    assert.deepEqual(specTags(compat), specTags(plain), kind);
    assert.deepEqual([mappingOf(compat), usesSpatialMapping(compat)], [mappingOf(plain), usesSpatialMapping(plain)], kind);
    compared++;
  }
  assert.ok(compared > 100, `${compared} hd and ldj kinds`);
});

test('kinds without a trigger: live input, their own rate or the beat, as their code reads', () => {
  const reactsOf = (raw) => specTags(raw.params ? raw : { ...raw, params: KINDS.get(raw.kind).defaults.params }).tags
    .filter((tag) => TAGS[tag].axis === 'reacts');
  const viaOf = (raw) => specTags({ ...raw, params: raw.params ?? KINDS.get(raw.kind).defaults.params }).via;
  const disco = KINDS.get('hd.disco').defaults.params;
  assert.deepEqual(reactsOf({ kind: 'hd.disco', params: { ...disco, style: 'spectrum' } }), ['bands']);
  assert.deepEqual(reactsOf({ kind: 'hd.disco', params: { ...disco, style: 'peak' } }), ['level']);
  assert.deepEqual(reactsOf({ kind: 'hd.disco', params: { ...disco, style: 'neural' } }), ['bands', 'level']);
  assert.deepEqual(viaOf({ kind: 'hd.disco' }), ['live']);
  assert.deepEqual([reactsOf({ kind: 'ldj.visualizer' }), viaOf({ kind: 'ldj.visualizer' })], [['level'], ['live']]);
  // Wall frames, wall delays and the wall-clock strobe follow a rate of their own, not the beat.
  for (const kind of ['ldj.TrueStrobe', 'ldj.Swirl', 'ldj.Perlin', 'ldj.MatrixPulse', 'ldj.PartyStrobe', 'ldj.SceneMakerFirework']) {
    assert.deepEqual(reactsOf({ kind }), ['static'], kind);
  }
  assert.deepEqual(reactsOf({ kind: 'strobe', params: { clock: 'wall', flashesPerSecond: 5, continueBetween: true } }), ['static']);
  const board = KINDS.get('ldj.matrixBoard').defaults.params;
  assert.deepEqual(reactsOf({ kind: 'ldj.matrixBoard', params: { ...board, mode: 'cycle' } }), ['beat']);
  assert.deepEqual(reactsOf({ kind: 'ldj.matrixBoard', params: { ...board, mode: 'pulses' } }), ['static']);
  // Beat-stepped rows, tempo-timed waves, bitmaps and studio notes follow the beat.
  for (const kind of ['ldj.StrobeCycle', 'ldj.GrooveWave', 'ldj.BigRoomWave', 'ldj.bitmap']) assert.deepEqual(reactsOf({ kind }), ['beat'], kind);
  // A macro plays its steps on the beat and reacts as they do.
  const step = (effect) => ({ effect, beats: 4 });
  assert.deepEqual(reactsOf({ kind: 'macro', params: { steps: [step({ kind: 'ldj.StrobeCycle', params: {} })], loopBeats: 4 } }), ['beat']);
  assert.deepEqual(reactsOf({ kind: 'macro', params: { steps: [step({ kind: 'ldj.visualizer', params: {} }), step({ kind: 'ldj.Swirl', params: {} })], loopBeats: 8 } }), ['level']);
});

test('the Strobe pattern is Static by default and its badge says the drawn functions follow the beat', () => {
  assert.deepEqual(legacyTags('strobe').tags, ['static', 'rig']);
  assert.match(TAG_NOTES.strobe.static, /Ramp.*Random.*Burst.*beat/);
});

test('one rule sorts a row into the MIDI and Companion browse lists', () => {
  const rows = [...PATTERNS, ...PRESET_ROWS];
  const lists = (rapid) => rows.filter((r) => !r.retired && (rapid || !r.rapidFlash)).reduce((acc, r) => { acc[browseListOf(r)]++; return acc; }, { pattern: 0, effect: 0, bars: 0 });
  assert.deepEqual(lists(true), { pattern: 81, effect: 11, bars: 21 });
  assert.deepEqual(lists(false), { pattern: 77, effect: 4, bars: 16 });
  assert.deepEqual([{}, { pixel: true }, { tags: ['beat', 'energy'] }].map(browseListOf), ['pattern', 'bars', 'effect']);
});
