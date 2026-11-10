// The pixel and panel layers take a spec, as the main look does. An id that
// resolves to one plays it on exactly the units the layer's part covers, as an
// effect of its own; an id with none keeps its pattern function. Both layers
// play over a main effect as they do over a classic main look, and the preview
// steps them through the same frames as the renderer.

import test from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';

import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { profilesRevision } from '../../src/server/profiles.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { state } from '../../src/server/state.ts';
import { renderInput, setEffectSource, stopEngine } from '../../src/server/engine.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { registerKind, validateSpec } from '../../src/shared/effects/registry.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { beatPositionAt, localBpm, makeGrid } from '../../src/shared/beat-clock.ts';
import { syntheticRig } from '../../scripts/golden-frames.js';

test.after(() => stopEngine());

// Lights each unit of its room with the room's size and the unit's place in it.
registerKind({
  kind: 'test.layerProbe', app: 'own', schema: z.object({}).strict(), defaults: { params: {} }, init: () => null,
  render(_params, _state, room, _frame, out) {
    for (let i = 0; i < room.n; i++) out[i] = { colour: { r: room.n, g: i, b: 9, w: 0, a: 0, uv: 0 }, level: 1, strength: 1 };
  },
});
const PROBE = validateSpec({ kind: 'test.layerProbe' });
const WAVE_ID = 'v2.grooveWave.2d';
const WAVE = presetById(WAVE_ID).spec;
const resolveEffect = (id) => (id === 'probe' ? PROBE : presetById(id) && !presetById(id).legacy ? presetById(id).spec : null);

// The synthetic room's pars, strip and panel; its Hue lamps answer in a colour space of their own.
const { fixtures: SYNTHETIC, profileOf } = syntheticRig();
const ROOM = SYNTHETIC.filter((f) => !f.hue);
const RIG = buildRig(ROOM, profileOf);
const PANEL_ID = 'synthetic-panel-12x8';
const STRIP_ID = 'synthetic-strip-30';
const unitsOf = (fixtures, test) => buildRig(fixtures, profileOf).units.flatMap(({ fixture }, u) => (test(fixtures[fixture]) ? [u] : []));
const PARS = unitsOf(ROOM, (f) => !profileOf(f).cells);
const STRIP = unitsOf(ROOM, (f) => f.profileId === STRIP_ID);
const PANEL = unitsOf(ROOM, (f) => f.profileId === PANEL_ID);
const CELLS = [...STRIP, ...PANEL];

const LOOK = { colorA: 0, colorB: 5, colorC: 3, colorD: 8, beatDivision: 1 };
const ACK = { hdFlashIntervalMs: 350, acknowledged: true };
const BASE = {
  running: true, pattern: 'solid', ...LOOK, split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard',
  masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
  universes: [0], safety: ACK,
};
const BEATS = Array.from({ length: 81 }, (_, i) => i * 0.5);
const GRID = { beats: BEATS };
const beatGrid = makeGrid(BEATS);
const frames = (to) => Array.from({ length: Math.floor(to / FRAME_MS + 1e-9) + 1 }, (_, k) => k * FRAME_MS);
const EMITTERS = { red: 'r', green: 'g', blue: 'b', white: 'w', amber: 'a', uv: 'uv' };
const pick = (run, units) => run.map((lights) => units.map((u) => lights[u]));
const ids = (look) => ({ effect: resolveEffect(look.pattern), pixelEffect: look.pixelPattern ? resolveEffect(look.pixelPattern) : null,
  panelEffect: look.panelPattern ? resolveEffect(look.panelPattern) : null });

/** The renderer's emitters per unit at each of `times`, playing `look` on `fixtures`. */
function rigRun(fixtures, times, look) {
  const rig = buildRig(fixtures, profileOf);
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf, profilesRevision, now: times[0] });
  return times.map((t) => {
    renderer.frame({ ...BASE, fixtures, ...look }, { beatPos: beatPositionAt(beatGrid, t), bpm: localBpm(beatGrid, t), epoch: 0 }, t, store, 0);
    const dmx = store.getBuffer(0);
    return rig.units.map(({ fixture, cell }) => {
      const f = fixtures[fixture], map = rig.cellMaps[fixture]?.[cell] ?? profileOf(f).channelMap;
      return Object.fromEntries(Object.entries(EMITTERS).filter(([name]) => map[name] !== undefined).map(([name, k]) => [k, dmx[f.address - 1 + map[name]]]));
    });
  });
}

test('a spec id as pixelPattern plays on exactly the cells the pixel layer covers, the pars on the main look', () => {
  const times = frames(500);
  const cells = RIG.layout(null, 'stage', 'cells').units.list;
  assert.deepStrictEqual([...cells].sort((a, b) => a - b), CELLS);
  const probed = rigRun(ROOM, times, { pattern: 'gradient', pixelPattern: 'probe', pixelEffect: PROBE });
  for (const lights of probed) cells.forEach((u, k) => assert.deepStrictEqual(lights[u], { r: cells.length, g: k, b: 9 }, `cell ${k}`));
  const classic = rigRun(ROOM, times, { pattern: 'gradient', pixelPattern: 'comet' });
  assert.deepStrictEqual(pick(probed, PARS), pick(classic, PARS), 'the pars play the main look as under a classic pixel layer');
});

test('a v2 preset as pixelPattern plays on the strip as it plays there as the main look', () => {
  const times = frames(2000);
  const parsAndStrip = ROOM.filter((f) => f.profileId !== PANEL_ID);
  const strip = unitsOf(parsAndStrip, (f) => f.profileId === STRIP_ID);
  const pars = unitsOf(parsAndStrip, (f) => !profileOf(f).cells);
  const layered = rigRun(parsAndStrip, times, { pattern: 'gradient', pixelPattern: WAVE_ID, pixelEffect: WAVE });
  const alone = rigRun(ROOM.filter((f) => f.profileId === STRIP_ID), times, { pattern: WAVE_ID, effect: WAVE });
  assert.deepStrictEqual(pick(layered, strip), alone);
  assert.ok(new Set(alone.map((lights) => JSON.stringify(lights))).size > 10, 'the wave moves along the strip');
  const classic = rigRun(parsAndStrip, times, { pattern: 'gradient', pixelPattern: 'comet' });
  assert.deepStrictEqual(pick(layered, pars), pick(classic, pars), 'the pars play the main look');
});

test('a spec id as panelPattern plays on exactly the panel, the pars and strip as under a classic panel layer', () => {
  const times = frames(500);
  const panel = RIG.layout(null, 'stage', 'panels').units.list;
  assert.deepStrictEqual([...panel].sort((a, b) => a - b), PANEL);
  for (const pixelPattern of [null, 'comet']) {
    const probed = rigRun(ROOM, times, { pattern: 'gradient', pixelPattern, panelPattern: 'probe', panelEffect: PROBE });
    for (const lights of probed) panel.forEach((u, k) => assert.deepStrictEqual(lights[u], { r: panel.length, g: k, b: 9 }, `panel cell ${k}`));
    const classic = rigRun(ROOM, times, { pattern: 'gradient', pixelPattern, panelPattern: 'plasma' });
    assert.deepStrictEqual(pick(probed, [...PARS, ...STRIP]), pick(classic, [...PARS, ...STRIP]), `pars and strip under pixel layer ${pixelPattern}`);
  }
  const wave = rigRun(ROOM, frames(2000), { pattern: 'gradient', panelPattern: WAVE_ID, panelEffect: WAVE });
  const alone = rigRun(ROOM.filter((f) => f.profileId === PANEL_ID), frames(2000), { pattern: WAVE_ID, effect: WAVE });
  assert.deepStrictEqual(pick(wave, PANEL), alone, 'a v2 preset plays on the panel as it plays there as the main look');
});

test('classic pixel and panel layers play over a main effect as over a classic main look', () => {
  const times = frames(2000);
  const effectOnly = rigRun(ROOM, times, { pattern: WAVE_ID, effect: WAVE });
  for (const layers of [{ pixelPattern: 'gradient' }, { panelPattern: 'plasma' }, { pixelPattern: 'comet', panelPattern: 'plasma' }]) {
    const over = rigRun(ROOM, times, { pattern: WAVE_ID, effect: WAVE, ...layers });
    const classicMain = rigRun(ROOM, times, { pattern: 'solid', ...layers });
    const covered = layers.panelPattern ? (layers.pixelPattern ? CELLS : PANEL) : CELLS;
    assert.deepStrictEqual(pick(over, covered), pick(classicMain, covered), `${JSON.stringify(layers)} draws its pattern`);
    assert.notDeepStrictEqual(pick(over, covered), pick(effectOnly, covered), `${JSON.stringify(layers)} is no longer dropped`);
    const rest = RIG.units.map((_, u) => u).filter((u) => !covered.includes(u));
    assert.deepStrictEqual(pick(over, rest), pick(effectOnly, rest), `${JSON.stringify(layers)}: the rest plays the main effect`);
  }
});

test('a random classic layer over a main effect holds its draw between steps', () => {
  // Frames 1 to 19 share the first step; the main effect moves on the pars meanwhile.
  const times = frames(480).slice(1);
  const over = rigRun(ROOM, times, { pattern: WAVE_ID, effect: WAVE, pixelPattern: 'sparkle' });
  assert.strictEqual(new Set(pick(over, CELLS).map((cells) => JSON.stringify(cells))).size, 1, 'the sparkle holds');
  assert.ok(new Set(pick(over, PARS).map((pars) => JSON.stringify(pars))).size > 1, 'the main effect moves');
});

test('the preview steps spec and classic layers as the renderer plays them', () => {
  const times = frames(1500);
  const looks = [
    { pattern: 'gradient', pixelPattern: WAVE_ID },
    { pattern: 'gradient', pixelPattern: 'comet', panelPattern: WAVE_ID },
    { pattern: WAVE_ID, pixelPattern: 'gradient', panelPattern: 'plasma' },
    { pattern: WAVE_ID, pixelPattern: 'probe' },
    // No spec anywhere: the preview answers from its timeline, the renderer draws the functions.
    { pattern: 'gradient', pixelPattern: 'comet', panelPattern: 'plasma' },
  ];
  for (const look of looks) {
    const lit = rigRun(ROOM, times, { ...look, ...ids(look) });
    const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { ...LOOK, bpm: 120, ...look } }], GRID, { resolveEffect, safety: ACK });
    times.forEach((t, i) => {
      const shown = sample(t, ROOM, COLOR_PRESETS, RIG);
      lit[i].forEach((light, u) => {
        const seen = Object.fromEntries(Object.keys(light).map((k) => [k, shown[u][k]]));
        assert.deepStrictEqual(seen, light, `${JSON.stringify(look)} unit ${u} at ${t} ms`);
      });
    });
    // The probe holds still by design; every other look moves, so the comparison is not of dark frames.
    if (look.pixelPattern !== 'probe') assert.ok(new Set(pick(lit, CELLS).map((cells) => JSON.stringify(cells))).size > 1, `${JSON.stringify(look)} moves on the bars`);
    else assert.ok(pick(lit, CELLS).every((cells) => cells.every((light) => light.b > 0)), 'the probe lights every cell');
  }
});

test('a layer spec that asks for the photosensitivity acknowledgement waits for it, as the main look does', () => {
  const RAPID = validateSpec({ kind: 'test.layerProbe', rapidFlash: true });
  const times = frames(250);
  const cells = RIG.layout(null, 'stage', 'cells').units.list;
  const lit = (run, units) => run.every((lights) => units.every((u) => Object.values(lights[u]).some((v) => v > 0)));
  const dark = (run, units) => run.every((lights) => units.every((u) => Object.values(lights[u]).every((v) => v === 0)));
  for (const acknowledged of [false, true]) {
    const safety = { hdFlashIntervalMs: 350, acknowledged };
    const main = rigRun(ROOM, times, { pattern: 'rapid', effect: RAPID, safety });
    const layered = rigRun(ROOM, times, { pattern: 'gradient', pixelPattern: 'rapid', pixelEffect: RAPID, safety });
    assert.ok(acknowledged ? lit(main, CELLS) : dark(main, CELLS), `the main look, acknowledged ${acknowledged}`);
    assert.ok(acknowledged ? lit(layered, cells) : dark(layered, cells), `the pixel layer, acknowledged ${acknowledged}`);
    assert.ok(lit(layered, PARS), 'the pars play the main look either way');
  }
});

test('the engine resolves the pixel and panel ids through its effect source, as it does the main look', () => {
  const saved = { pattern: state.pattern, pixelPattern: state.pixelPattern, panelPattern: state.panelPattern };
  setEffectSource((id) => (id === 'probe' ? PROBE : null));
  try {
    Object.assign(state, { pattern: 'solid', pixelPattern: 'probe', panelPattern: 'comet' });
    const input = renderInput();
    assert.strictEqual(input.effect, null);
    assert.strictEqual(input.pixelEffect, PROBE, 'an id with a spec plays it');
    assert.strictEqual(input.panelEffect, null, 'an id with none keeps its pattern function');
    Object.assign(state, { pixelPattern: null, panelPattern: 'probe' });
    assert.deepStrictEqual([renderInput().pixelEffect, renderInput().panelEffect], [null, PROBE]);
  } finally {
    setEffectSource(null);
    Object.assign(state, saved);
  }
});
