// White reaches the lamps only where white is what was picked: a white colour preset chosen for a slot, the white
// strobe and the blinder by name, and the looks and palettes whose name says white. Everywhere else no slot, default,
// draw or generated colour is white or pale.
//
// Pale is isPale (src/shared/color.ts): folded to red, green and blue as a lamp without white, amber and UV dies
// shows it, the three channels share half the peak or more (HSV saturation 0.5 or less). The white and pale presets
// (Warm White, Cool White, Lavender, Moonlight) fold to 0.23 to 0.50, every saturated preset to 0.81 or more.

import test from 'node:test';
import assert from 'node:assert';

import { UV_BOOST, colourMixer, isPale, mixColours } from '../../src/shared/color.ts';
import { HEX_COLOUR, START_COLOURS, parseHex, toHex } from '../../src/shared/palette-model.ts';
import { samplePalette } from '../../src/shared/effects/palette.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';
import { DUOS, PALETTE_IDS, PALETTE_NAMES, TETRADS, TRIADS, WHITE_LOOKS } from '../../src/server/palettes.ts';
import { ALL_PALETTES } from '../../src/server/palette-catalogue.ts';
import { CATALOGUE, LEGACY_PRESETS, presetById } from '../../src/shared/effects/catalogue.ts';
import { KINDS } from '../../src/shared/effects/registry.ts';
import { WHITE_ENERGY } from '../../src/shared/effects/energy.ts';
import { burstFor } from '../../src/show/look.ts';
import { DEFAULTS } from '../../src/server/settings.ts';
import { state } from '../../src/server/state.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { profilesRevision } from '../../src/server/profiles.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { DEMO_AUDIO_SOURCE, DEMO_BPM } from '../../src/shared/demo-track.ts';
import { syntheticRig, syntheticSpace } from '../../scripts/golden-frames.js';

const WHITE_PRESETS = new Set(['Warm White', 'Cool White', 'Lavender', 'Moonlight']);
// The palettes whose name says white: the looks, the entertainment table's White/Off and the party set's white strobe.
const WHITE_PALETTES = new Set(['arctic', 'lunar', 'whiteout', 'whiteOff', 'hdStrobe']);
// The presets that are white by name: the white strobe and the blinder.
const WHITE_PICKS = new Set(['energy.whiteStrobe', 'energy.blinder']);

const hexes = (value, path = []) => typeof value === 'string' ? (HEX_COLOUR.test(value) ? [[path.join('.'), value]] : [])
  : value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => hexes(v, [...path, k])) : [];

test('the line between pale and saturated: the four white presets fall on the pale side, every other preset on the other', () => {
  for (const preset of COLOR_PRESETS) {
    if (preset.name === 'Blackout') assert.equal(isPale(preset), false, 'black gives no light');
    else assert.equal(isPale(preset), WHITE_PRESETS.has(preset.name), preset.name);
  }
  assert.equal(isPale(parseHex('#FFFFFF')), true);
  assert.equal(isPale(parseHex('#F472B6')), false, 'a light pink is a colour');
});

test('only the looks whose name says white hold white or pale presets, at every size', () => {
  assert.deepEqual([...WHITE_LOOKS].map((id) => PALETTE_NAMES[id]).sort(), ['Arctic', 'Lunar', 'Whiteout']);
  for (const id of PALETTE_IDS) {
    for (const [size, bank] of [[4, TETRADS], [3, TRIADS], [2, DUOS]]) {
      const pale = bank[id].filter((i) => isPale(COLOR_PRESETS[i])).map((i) => COLOR_PRESETS[i].name);
      if (WHITE_LOOKS.has(id)) continue;
      assert.deepEqual(pale, [], `${PALETTE_NAMES[id]} at ${size}`);
    }
  }
});

test('every built-in palette is saturated, but those whose name says white', () => {
  for (const palette of ALL_PALETTES) {
    if (WHITE_PALETTES.has(palette.id)) continue;
    for (const entry of palette.colours) {
      if (typeof entry === 'string') assert.equal(isPale(parseHex(entry)), false, `${palette.id} ${entry}`);
    }
  }
});

test('no preset carries a white or pale colour of its own, nor any kind in its defaults', () => {
  const rows = [...CATALOGUE, ...LEGACY_PRESETS].filter((row) => row.spec && !WHITE_PICKS.has(row.id));
  assert.ok(rows.length > 300);
  for (const row of rows) {
    for (const [path, hex] of hexes(row.spec)) assert.equal(isPale(parseHex(hex)), false, `${row.id} ${path} ${hex}`);
  }
  for (const [kind, def] of KINDS) {
    for (const [path, hex] of hexes(def.defaults)) assert.equal(isPale(parseHex(hex)), false, `${kind} defaults ${path} ${hex}`);
  }
});

test('the defaults a fresh start or a new colour begins from are the fresh look\'s saturated colours', () => {
  const fresh = [state.colorA, state.colorB, state.colorC, state.colorD];
  assert.deepEqual([...START_COLOURS], fresh.map((i) => toHex(COLOR_PRESETS[i])));
  for (const hex of [...START_COLOURS, ...DEFAULTS.strobe.palette]) assert.equal(isPale(parseHex(hex)), false, hex);
  for (const i of fresh) assert.equal(isPale(COLOR_PRESETS[i]), false);
  assert.equal(isPale(samplePalette([], 0.3)), false, 'an empty palette plays a colour, not white');
});

test('the auto show never picks a burst in white', () => {
  const unit = [0, 0.2, 0.4, 0.6, 0.8, 1];
  for (const moment of ['drop', 'accent']) {
    for (const drive of unit) for (const energy of unit) for (const air of unit) for (const dark of unit) for (const vocal of [false, true]) {
      const kind = burstFor({ moment, drive, vocal, character: { energy, texture: air, hats: air },
        score: { semantic: { aggressive: dark, dark, triumphant: 1 - dark }, articulation: air } });
      assert.ok(!WHITE_ENERGY.has(kind), `${moment} at drive ${drive}, energy ${energy}: ${kind}`);
    }
  }
});

test('a mix of two colours that are not pale is never pale', () => {
  const colours = COLOR_PRESETS.filter((c) => !isPale(c) && c.name !== 'Blackout');
  for (const from of colours) {
    for (const to of colours) {
      const blend = colourMixer(from, to);
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        assert.equal(isPale(mixColours(from, to, t)), false, `${from.name} to ${to.name} at ${t}, straight`);
        assert.equal(isPale(blend(t)), false, `${from.name} to ${to.name} at ${t}, round the wheel`);
      }
    }
  }
  const red = COLOR_PRESETS[0], cyan = COLOR_PRESETS[4], black = COLOR_PRESETS[14];
  assert.deepEqual([mixColours(red, cyan, 0), mixColours(red, cyan, 1)],
    [{ r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 }, { r: 0, g: 225, b: 255, w: 0, a: 0, uv: 0 }], 'the ends are the two colours');
  assert.deepEqual(mixColours(red, black, 0.5), { r: 128, g: 0, b: 0, w: 0, a: 0, uv: 0 }, 'a fade to dark is a plain mix');
  assert.deepEqual(mixColours(cyan, { r: 0, g: 112, b: 128 }, 0.5), { r: 0, g: 169, b: 192, w: 0, a: 0, uv: 0 }, 'one hue: a plain mix');
});

// Every unit's colour, folded as transport folds it for a lamp without the dies, at a level that is more than rounding.
const LIT = 24;
function rendered(id, slots, background) {
  const { fixtures, profileOf } = syntheticRig();
  const rig = buildRig(fixtures, profileOf);
  const units = rig.units.map(({ fixture, cell }) => {
    const f = fixtures[fixture], maps = rig.cellMaps[fixture];
    return { base: f.address - 1, map: maps ? maps[cell] : profileOf(f).channelMap, dimmer: maps ? undefined : profileOf(f).channelMap.dimmer };
  });
  const renderer = createRenderer({ profileOf, profilesRevision, now: 0 });
  renderer.setSpace(syntheticSpace());
  const store = universes.createUniverseStore(universes.allocateShared());
  const input = {
    running: true, pattern: id, colorA: slots[0], colorB: slots[1], colorC: slots[2], colorD: slots[3], beatDivision: 1,
    split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
    energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures, background,
    safety: { acknowledged: true, hdFlashIntervalMs: 350 }, effect: presetById(id)?.spec ?? null,
  };
  const pale = [];
  for (let k = 0; k < 48; k++) {
    const beatPos = k * 0.6667 + 0.01, ms = beatPos * 500;
    input.audio = { ...DEMO_AUDIO_SOURCE.frameAt(ms * 120 / DEMO_BPM), t: ms };
    input.audioMode = 'reactive';
    input.modulation = DEMO_AUDIO_SOURCE.modulationAt(ms * 120 / DEMO_BPM);
    renderer.frame(input, { beatPos, bpm: 120, epoch: 0 }, ms, store);
    const buffer = store.getBuffer(0);
    for (const u of units) {
      const at = (offset) => offset === undefined ? 0 : buffer[u.base + offset];
      const m = u.map;
      // The UV byte is already boosted as the dies emit it; isPale boosts a colour's.
      const colour = { r: at(m.red), g: at(m.green), b: at(m.blue), w: Math.max(at(m.white), at(m.coolWhite)),
        a: Math.max(at(m.amber), at(m.warmWhite)), uv: at(m.uv) / UV_BOOST };
      const peak = Math.max(colour.r + colour.w + colour.a + colour.uv * 0.45, colour.g + colour.w + colour.a, colour.b + colour.w + colour.uv);
      if (Math.min(255, peak) * (u.dimmer === undefined ? 1 : at(u.dimmer) / 255) >= LIT && isPale(colour)) pale.push(`beat ${beatPos.toFixed(2)} ${JSON.stringify(colour)}`);
    }
  }
  return pale;
}

// The looks to render on: the fresh start's opposites side by side, amber next to blue, UV next to cyan, and a duo.
const LOOKS = [['the fresh start', [0, 6, 4, 8]], ['Royal', TETRADS.royal], ['Noir UV', TETRADS.noirUv],
  ['Halloween', TETRADS.halloween], ['Hard Techno as a duo', [...DUOS.hardTechno, ...DUOS.hardTechno]]];
const IDS = [...new Set([...CATALOGUE.map((p) => p.id), ...PATTERNS.map((p) => p.id)])].filter((id) => !WHITE_PICKS.has(id));

for (const [name, slots] of LOOKS) {
  test(`every effect and classic pattern renders no pale light on ${name}`, () => {
    const found = IDS.flatMap((id) => rendered(id, slots).slice(0, 1).map((first) => `${id}: ${first}`));
    assert.deepEqual(found, []);
  });
}

test('a Fixed background opposite the look mixes into no pale light', () => {
  const background = { version: 1, mode: 'fixed', level: 0.6, colour: { r: 0, g: 225, b: 255, w: 0, a: 0, uv: 0 } };
  const found = IDS.flatMap((id) => rendered(id, [0, 8, 1, 6], background).slice(0, 1).map((first) => `${id}: ${first}`));
  assert.deepEqual(found, []);
});
