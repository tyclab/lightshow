// The Background card's Fixed colour is the base layer under everything the show plays: every effect
// family, pattern pads, voices, sequence clips, classic patterns and the visualizer's room picture show
// it wherever they leave a lamp dark or dim. An effect set to Keep dark and the explicit dark cues
// (strobe rests, Kill, a black foreground at full opacity, blackouts) stay dark. Follow and Off are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, withInputDefaults } from '../../src/server/renderer.ts';
import { createUniverseStore } from '../../src/server/universes.ts';
import { gapsApply, validateSpec } from '../../src/shared/effects/registry.ts';
import { CATALOGUE, presetById } from '../../src/shared/effects/index.ts';
import { DEFAULT_BACKGROUND } from '../../src/shared/background.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';

const emitters = ['red', 'green', 'blue', 'white', 'amber', 'uv'];
const profile = { id: 'six-emitter-base', channelCount: 6, channelMap: Object.fromEntries(emitters.map((c, i) => [c, i])) };
const fixtures = Array.from({ length: 8 }, (_, id) => ({ id, address: id * 6 + 1, universe: 0, profileId: profile.id,
  maxBrightness: 255, override: null, position: { x: id * 100 / 7, y: 50 }, group: null, geometry: null, hue: false }));
const colour = { r: 160, g: 120, b: 80, w: 100, a: 90, uv: 60 };
const fixed = { ...DEFAULT_BACKGROUND, mode: 'fixed', colour, level: .3 };
const follow = { ...DEFAULT_BACKGROUND, level: .6 };
const off = { ...DEFAULT_BACKGROUND, mode: 'off' };
// The Fixed colour at level .3 on the wire, UV calibration included.
const WASH = [48, 36, 24, 30, 27, 32];
const look = { running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 4, colorD: 8, split: null, pixelMap: 'stage',
  masterDimmer: 255, beatDivision: 1, fixtures, universes: [0], flashLimit: false, safety: { acknowledged: true, hdFlashIntervalMs: 0 } };
function engine(patch = {}) {
  const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => 0, now: 0 });
  const store = createUniverseStore();
  return { renderer, draw(now, change = {}) {
    renderer.frame(withInputDefaults({ ...look, ...patch, ...change }), { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store);
    return [...store.getBuffer(0).slice(0, fixtures.length * 6)];
  } };
}
const lamps = (bytes) => Array.from({ length: bytes.length / 6 }, (_, i) => bytes.slice(i * 6, i * 6 + 6));
const dark = (bytes) => bytes.every((byte) => byte === 0);
const washed = (lamp) => lamp.join() === WASH.join();
const with_ = (spec, gaps) => validateSpec({ ...spec, background: { ...spec.background, gaps } });
const run = (patch, times) => { const e = engine(patch); return times.map((now) => e.draw(now)); };
const TIMES = [0, 125, 250, 375, 500, 750, 1000, 1250, 1500, 2000];
const darkLamps = (frames) => frames.flatMap(lamps).filter(dark).length;

test('Fixed fills every lamp an Entertainment chase, a continuous field, a Disco or a raster leaves dark', () => {
  for (const id of ['ldj.FadeCycle', 'ldj.ThreeStageFade', 'ldj.Beacon', 'hd.disco.pop', 'ldj.bitmap.VertLines', 'ldj.bitmap.SolidBlackBGSineWave']) {
    const { spec } = presetById(id);
    const unlit = run({ effect: spec, background: off }, TIMES), shown = run({ effect: spec, background: fixed }, TIMES);
    let filled = 0;
    unlit.forEach((frame, k) => lamps(frame).forEach((lamp, i) => {
      if (!dark(lamp)) return;
      assert.ok(washed(lamps(shown[k])[i]), `${id}: unlit lamp ${i} at ${TIMES[k]} ms takes the whole Fixed colour`);
      filled++;
    }));
    assert.ok(filled > 0, `negative control: ${id} leaves lamps dark`);
    assert.ok(darkLamps(run({ effect: with_(spec, 'dark'), background: fixed }, TIMES)) > 0, `${id}: Keep dark still leaves its own black`);
  }
});

test('wherever an effect offers the choice, Reveal fills lamps Keep dark leaves dark, and Follow and Off cannot tell them apart', () => {
  const times = [0, 250, 900, 2000];
  let offered = 0;
  for (const preset of CATALOGUE) {
    if (preset.legacy || !preset.spec || !gapsApply(preset.spec)) continue;
    offered++;
    const kept = with_(preset.spec, 'dark');
    const keptDark = darkLamps(run({ effect: kept, background: fixed }, times)), shownDark = darkLamps(run({ effect: preset.spec, background: fixed }, times));
    assert.ok(shownDark <= keptDark, `${preset.id}: Reveal never darkens a lamp`);
    if (keptDark) assert.ok(shownDark < keptDark, `${preset.id}: Reveal fills some of the ${keptDark} lamps Keep dark leaves dark`);
    for (const background of [DEFAULT_BACKGROUND, follow, off]) {
      assert.deepEqual(run({ effect: preset.spec, background }, times), run({ effect: kept, background }, times), `${preset.id} under ${background.mode} ${background.level}`);
    }
  }
  assert.ok(offered > 20, `negative control: ${offered} catalogue effects offer the choice`);
});

test('explicit dark cues stay dark over the Fixed colour: strobe rests, Kill, the Blackout scene, the ring strobe', () => {
  const strobe = run({ effect: presetById('v2.scatterStrobe').spec, background: fixed }, TIMES);
  assert.ok(strobe.some((frame) => lamps(frame).some((lamp) => !dark(lamp))), 'negative control: the strobe flashes');
  assert.ok(darkLamps(strobe) > 0 && !strobe.flatMap(lamps).some(washed), 'its rests stay dark');
  const kill = { id: 'kill', spec: validateSpec({ kind: 'energy.kill' }), targets: null, tier: 'voice', launchSeq: 1,
    startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] };
  assert.ok(dark(engine({ effect: presetById('ldj.FadeCycle').spec, background: fixed }).draw(500, { voices: [kill] })), 'Kill owns black');
  assert.ok(run({ effect: presetById('ldj.Blackout').spec, background: fixed }, TIMES).every(dark), 'the Blackout scene owns black');
  const ring = run({ pattern: 'ring-strobe', background: fixed }, TIMES);
  assert.ok(darkLamps(ring) > 0 && !ring.flatMap(lamps).some(washed), 'the ring strobe’s rests stay dark');
});

test('classic patterns show the Fixed colour between their pops', () => {
  const unlit = run({ pattern: 'confetti', background: off }, TIMES), shown = run({ pattern: 'confetti', background: fixed }, TIMES);
  let filled = 0;
  unlit.forEach((frame, k) => lamps(frame).forEach((lamp, i) => { if (dark(lamp)) { assert.ok(washed(lamps(shown[k])[i])); filled++; } }));
  assert.ok(filled > 0, 'negative control: confetti leaves lamps dark');
  for (const background of [DEFAULT_BACKGROUND, follow, off]) {
    assert.deepEqual(run({ pattern: 'confetti', background }, TIMES).map((frame) => lamps(frame).map(dark)), unlit.map((frame) => lamps(frame).map(dark)),
      `${background.mode} ${background.level}: no lamp lights or darkens`);
  }
});

test('a voice playing an effect shows the Fixed colour under its own black, never the look beneath', () => {
  const voice = { id: 'pad', spec: presetById('ldj.FadeCycle').spec, targets: null, tier: 'voice', launchSeq: 1,
    startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] };
  const plain = engine().draw(250, { voices: [voice] }), shown = engine({ background: fixed }).draw(250, { voices: [voice] });
  assert.ok(lamps(engine().draw(250)).every((lamp) => !dark(lamp)), 'negative control: the solid look lights every lamp');
  const gaps = lamps(plain).flatMap((lamp, i) => (dark(lamp) ? [i] : []));
  assert.ok(gaps.length > 0, 'negative control: the voice leaves its own black over the look');
  for (const i of gaps) assert.ok(washed(lamps(shown)[i]), `lamp ${i} shows the Fixed colour`);
  const kept = { ...voice, spec: with_(voice.spec, 'dark') };
  for (const i of gaps) assert.ok(dark(lamps(engine({ background: fixed }).draw(250, { voices: [kept] }))[i]), `lamp ${i} stays the voice's black when kept dark`);
});

test('the visualizer room picture plays over the Fixed colour, which fills the share each unit leaves dark', () => {
  // One unit each: black, full red, half red, white; the rest black.
  const rgb = [[0, 0, 0], [255, 0, 0], [128, 0, 0], [255, 255, 255], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const picture = { leaseId: 'base-test', signature: 'rig', units: 8, expiresAt: 1e12, data: Uint8Array.from(rgb.flat()) };
  const draw = (background) => lamps(engine({ background, picture }).draw(500));
  const plain = draw(DEFAULT_BACKGROUND), shown = draw(fixed);
  assert.deepEqual(plain[0], [0, 0, 0, 0, 0, 0], 'negative control: a black unit is dark without the Fixed colour');
  assert.deepEqual(plain[1], [255, 0, 0, 0, 0, 0], 'negative control: the picture paints the unit');
  assert.deepEqual(shown[0], WASH, 'a black unit shows the whole Fixed colour');
  assert.deepEqual(shown[1], plain[1], 'a full colour covers it');
  assert.deepEqual(shown[3], plain[3], 'so does white');
  const share = 1 - 128 / 255;
  [128 + 160 * .3 * share, 120 * .3 * share, 80 * .3 * share, 100 * .3 * share, 90 * .3 * share].forEach((expected, c) =>
    assert.ok(Math.abs(shown[2][c] - expected) <= 1, `half red, emitter ${c}: ${shown[2][c]} vs ${expected}`));
  for (const background of [follow, off]) assert.deepEqual(draw(background), plain, `${background.mode}: the picture plays as sent`);
  const scoped = draw({ ...fixed, fixtures: 'selected', selected: [4] });
  assert.deepEqual(scoped[4], WASH, 'the fixture scope reaches the picture');
  assert.deepEqual(scoped[0], plain[0], 'outside it the picture plays as sent');
});

test('the rehearsal preview shows the same base layer as the renderer', () => {
  const rig = buildRig(fixtures, () => profile);
  for (const [pattern, effect] of [['base-test', presetById('ldj.Beacon').spec], ['base-test', presetById('hd.disco.pop').spec], ['confetti', null]]) {
    const e = engine({ pattern, effect, background: fixed, paletteOverride: null });
    const preview = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { ...look, pattern, paletteOverride: null } }], null,
      { background: fixed, profiles: { [profile.id]: profile }, resolveEffect: () => effect, safety: look.safety });
    for (let tick = 0; tick < 30; tick++) {
      const now = tick * 1000 / 44;
      const wire = e.draw(now), shown = preview(now, fixtures, COLOR_PRESETS, rig).flatMap((c) => emitters.map((_, k) => c[['r', 'g', 'b', 'w', 'a', 'uv'][k]] ?? 0));
      wire.forEach((value, index) => assert.ok(Math.abs(value - shown[index]) <= 1, `${effect?.kind ?? pattern} byte ${index} at ${now}: ${value}/${shown[index]}`));
    }
  }
});
