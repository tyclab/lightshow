// Background "Follow effect" lights the main effect's gaps in its own colour. The operator asked for it three times
// ("we should make sure we have option follow effect colours", "3rd time i ask"); #102 left Follow dark between notes
// for effects without an ambient layer. Follow keeps every bed the effect authors, fills a gap with the effect's first
// colour at the classic Fade floor (25 of 255) times the Follow level, in proportion to the share the light leaves
// uncovered, and leaves Keep dark, explicit dark cues, pads, clips, voices and pictures as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, withInputDefaults } from '../../src/server/renderer.ts';
import { createUniverseStore } from '../../src/server/universes.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { presetById } from '../../src/shared/effects/index.ts';
import { DEFAULT_BACKGROUND, FOLLOW_FLOOR, followColourOf } from '../../src/shared/background.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';

const profile = { id: 'rgb-follow', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const fixtures = Array.from({ length: 8 }, (_, id) => ({ id, address: id * 3 + 1, universe: 0, profileId: profile.id, maxBrightness: 255,
  override: null, position: { x: id * 100 / 7, y: 50 }, group: null, geometry: null, hue: false }));
const look = { running: true, pattern: 'look', colorA: 0, colorB: 5, colorC: 4, colorD: 8, split: null, pixelMap: 'stage', masterDimmer: 255,
  beatDivision: 1, fixtures, universes: [0], flashLimit: false, safety: { acknowledged: true, hdFlashIntervalMs: 0 }, paletteOverride: null };
const chase = validateSpec({ kind: 'ldj.FadeCycle', palette: ['#00FF00', '#0000FF'] });
const TIMES = [0, 125, 250, 375, 500, 750, 1000, 1250];
const lamps = (bytes) => Array.from({ length: bytes.length / 3 }, (_, i) => bytes.slice(i * 3, i * 3 + 3));
const dark = (lamp) => lamp.every((byte) => byte === 0);

function run(patch, times = TIMES) {
  const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => 0, now: 0 });
  const store = createUniverseStore();
  return times.map((now) => {
    renderer.frame(withInputDefaults({ ...look, ...patch }), { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store);
    return [...store.getBuffer(0).slice(0, fixtures.length * 3)];
  });
}

test('the floor is the classic Fade floor, and the colour the main effect plays first', () => {
  assert.equal(Math.round(FOLLOW_FLOOR * 255), 25);
  const red = { r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 }, look_ = { r: 0, g: 0, b: 255, w: 0, a: 0, uv: 0 };
  assert.deepEqual(followColourOf(chase, null, look_), { r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0 }, 'the effect\'s own palette');
  assert.deepEqual(followColourOf(chase, [red], look_), red, 'the palette override while it plays');
  assert.deepEqual(followColourOf(null, null, look_), look_, 'a classic pattern: the look\'s first colour');
  assert.deepEqual(followColourOf({ palette: [{ random: true }, '#FF0000'] }, null, look_), red, 'the first fixed entry');
});

test('Follow lights each lamp the chase leaves dark in its first colour at the floor times the level; Off and Keep dark stay dark', () => {
  const off = run({ effect: chase, background: { ...DEFAULT_BACKGROUND, mode: 'off' } });
  const kept = run({ effect: validateSpec({ ...chase, background: { ...chase.background, gaps: 'dark' } }), background: DEFAULT_BACKGROUND });
  for (const level of [1, 0.6]) {
    const followed = run({ effect: chase, background: { ...DEFAULT_BACKGROUND, level } });
    let filled = 0;
    followed.forEach((frame, k) => lamps(frame).forEach((lamp, i) => {
      if (!dark(lamps(off[k])[i])) return;
      assert.deepEqual(lamp, [0, Math.round(25 * level), 0], `level ${level}: lamp ${i} at ${TIMES[k]} ms`);
      assert.ok(dark(lamps(kept[k])[i]), 'Keep dark leaves it the effect\'s black');
      filled++;
    }));
    assert.ok(filled > 8, `negative control: the chase leaves lamps dark (${filled})`);
  }
});

test('explicit dark cues stay dark under Follow: strobe rests and the Blackout scene', () => {
  const strobe = run({ effect: presetById('v2.scatterStrobe').spec, background: DEFAULT_BACKGROUND });
  assert.ok(strobe.some((frame) => lamps(frame).some((lamp) => !dark(lamp))), 'negative control: the strobe flashes');
  assert.ok(strobe.every((frame) => lamps(frame).some(dark)), 'its rests stay dark');
  assert.ok(run({ effect: presetById('ldj.Blackout').spec, background: DEFAULT_BACKGROUND }).every((frame) => frame.every((b) => b === 0)));
});

test('a pad keeps its own black over the main effect under Follow; only the main effect\'s gaps take its colour', () => {
  const pad = { id: 'pad', spec: chase, targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] };
  const solid = { pattern: 'solid', effect: null, colorA: 0 };
  const under = run({ ...solid, background: DEFAULT_BACKGROUND, voices: [pad] }), asDrawn = run({ ...solid, voices: [pad] });
  assert.deepEqual(under, asDrawn, 'the pad\'s gaps are its own black, Follow or not');
  assert.ok(asDrawn.some((frame) => lamps(frame).some(dark)), 'negative control: the pad leaves lamps dark');
});

test('stopped, Follow shows the main effect\'s colour at the floor where it authored no bed', () => {
  const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => 0, now: 0 });
  const store = createUniverseStore();
  const draw = (now, patch) => {
    renderer.frame(withInputDefaults({ ...look, effect: chase, background: DEFAULT_BACKGROUND, ...patch }), { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store);
    return lamps([...store.getBuffer(0).slice(0, fixtures.length * 3)]);
  };
  for (const now of [0, 125, 250]) draw(now, {});
  const stopped = draw(500, { programmePlaying: false, running: false });
  for (const lamp of stopped) assert.ok(lamp[0] === 0 && lamp[1] <= 25 && lamp[2] === 0, `${lamp}`);
  assert.ok(stopped.some((lamp) => lamp[1] === 25), 'the whole floor, as Fixed shows its whole colour when stopped');
});

test('the rehearsal preview shows the same Follow fill as the rig', () => {
  const rig = buildRig(fixtures, () => profile);
  for (const background of [DEFAULT_BACKGROUND, { ...DEFAULT_BACKGROUND, level: 0.6 }]) {
    const wire = run({ effect: chase, background }, TIMES);
    const preview = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { ...look, pattern: 'chase-effect' } }], null,
      { background, profiles: { [profile.id]: profile }, resolveEffect: (id) => (id === 'chase-effect' ? chase : null), safety: look.safety });
    TIMES.forEach((now, k) => {
      const shown = preview(now, fixtures, COLOR_PRESETS, rig).flatMap((c) => [c.r, c.g, c.b].map(Math.round));
      wire[k].forEach((v, i) => assert.ok(Math.abs(v - shown[i]) <= 1, `${background.level} byte ${i} at ${now} ms: ${v}/${shown[i]}`));
    });
  }
});
