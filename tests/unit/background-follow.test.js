// Background "Follow effect" can light the main effect's gaps in its own colour. The operator asked for it three times
// ("we should make sure we have option follow effect colours", "3rd time i ask") and, asked how bright, answered
// "i must see it to decide": so the fill is a choice on the card. Off (the default) renders exactly as before; Glow
// fills a gap at the classic Fade floor (25 of 255) times the Follow level; Full fills it at the level, as Fixed fills
// with its colour. Either way in proportion to the uncovered share, keeping beds, Keep dark, dark cues, pads, clips,
// voices and pictures as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, withInputDefaults } from '../../src/server/renderer.ts';
import { createUniverseStore } from '../../src/server/universes.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { presetById } from '../../src/shared/effects/index.ts';
import { DEFAULT_BACKGROUND, FOLLOW_FLOOR, backgroundSchema, followColourOf, storedBackground } from '../../src/shared/background.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { state } from '../../src/server/state.ts';
import { captureLook } from '../../src/server/cues.ts';
import { stopEngine } from '../../src/server/engine.ts';
import { backgroundDigest } from '../helpers/background-digest.js';

test.after(() => stopEngine());

const profile = { id: 'rgb-follow', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const fixtures = Array.from({ length: 8 }, (_, id) => ({ id, address: id * 3 + 1, universe: 0, profileId: profile.id, maxBrightness: 255,
  override: null, position: { x: id * 100 / 7, y: 50 }, group: null, geometry: null, hue: false }));
const look = { running: true, pattern: 'look', colorA: 0, colorB: 5, colorC: 4, colorD: 8, split: null, pixelMap: 'stage', masterDimmer: 255,
  beatDivision: 1, fixtures, universes: [0], flashLimit: false, safety: { acknowledged: true, hdFlashIntervalMs: 0 }, paletteOverride: null };
const chase = validateSpec({ kind: 'ldj.FadeCycle', palette: ['#00FF00', '#0000FF'] });
const TIMES = [0, 125, 250, 375, 500, 750, 1000, 1250];
const lamps = (bytes) => Array.from({ length: bytes.length / 3 }, (_, i) => bytes.slice(i * 3, i * 3 + 3));
const dark = (lamp) => lamp.every((byte) => byte === 0);
const follow = (followFill, level = 1) => ({ ...DEFAULT_BACKGROUND, level, followFill });

function run(patch, times = TIMES) {
  const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => 0, now: 0 });
  const store = createUniverseStore();
  return times.map((now) => {
    renderer.frame(withInputDefaults({ ...look, ...patch }), { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store);
    return [...store.getBuffer(0).slice(0, fixtures.length * 3)];
  });
}

// Taken on main (840a1fd) before the fill existed, with tests/helpers/background-digest.js unchanged.
const BEFORE_THE_FILL = 'ff3199bdca525a2b180168aea9668810d2463381435db2c33d4ae25f96d8b4db';
// Taken on this change, the first time Glow and Full render; any later move needs an explained change.
const GLOW = '1db01bc05d0b88dce534087ac926e7999117a567ceaa0f70eb0821d0ff64df0f';
const FULL = 'e5d765354c62b589373f4b82638d55d198ad0aa66fdce18b45aa3ba06987cd8e';

test('with the fill off, the default, every pattern and catalogue row renders and previews byte for byte as before the fill existed', () => {
  assert.equal(backgroundDigest([DEFAULT_BACKGROUND, follow(undefined, 0.6), follow('off', 0.6)]), BEFORE_THE_FILL);
  assert.equal(DEFAULT_BACKGROUND.followFill, undefined);
});

test('Glow and Full render every pattern and catalogue row as pinned', () => {
  assert.equal(backgroundDigest([follow('glow'), follow('glow', 0.6)]), GLOW);
  assert.equal(backgroundDigest([follow('full'), follow('full', 0.3)]), FULL);
});

test('the glow floor is the classic Fade floor, and the colour the main effect plays first', () => {
  assert.equal(Math.round(FOLLOW_FLOOR * 255), 25);
  const red = { r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 }, look_ = { r: 0, g: 0, b: 255, w: 0, a: 0, uv: 0 };
  assert.deepEqual(followColourOf(chase, null, look_), { r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0 }, 'the effect\'s own palette');
  assert.deepEqual(followColourOf(chase, [red], look_), red, 'the palette override while it plays');
  assert.deepEqual(followColourOf(null, null, look_), look_, 'a classic pattern: the look\'s first colour');
  assert.deepEqual(followColourOf({ palette: [{ random: true }, '#FF0000'] }, null, look_), red, 'the first fixed entry');
});

test('Glow and Full light each lamp the chase leaves dark in its first colour, at the floor or at the level; Off, Keep dark and Fixed are untouched', () => {
  const off = run({ effect: chase, background: { ...DEFAULT_BACKGROUND, mode: 'off' } });
  const authored = run({ effect: chase, background: DEFAULT_BACKGROUND });
  const keepDark = validateSpec({ ...chase, background: { ...chase.background, gaps: 'dark' } });
  for (const [fill, level, expected] of [['glow', 1, 25], ['glow', 0.6, 15], ['full', 1, 255], ['full', 0.3, 77]]) {
    const filled = run({ effect: chase, background: follow(fill, level) }), kept = run({ effect: keepDark, background: follow(fill, level) });
    let gaps = 0;
    filled.forEach((frame, k) => lamps(frame).forEach((lamp, i) => {
      if (!dark(lamps(off[k])[i])) return;
      assert.ok(dark(lamps(authored[k])[i]), 'negative control: without the fill the gap is dark');
      assert.deepEqual(lamp, [0, expected, 0], `${fill} ${level}: lamp ${i} at ${TIMES[k]} ms`);
      assert.ok(dark(lamps(kept[k])[i]), 'Keep dark leaves it the effect\'s black');
      gaps++;
    }));
    assert.ok(gaps > 8, `negative control: the chase leaves lamps dark (${gaps})`);
  }
  const fixed = { ...DEFAULT_BACKGROUND, mode: 'fixed', level: 0.3, colour: { r: 160, g: 120, b: 80, w: 0, a: 0, uv: 0 } };
  assert.deepEqual(run({ effect: chase, background: { ...fixed, followFill: 'full' } }), run({ effect: chase, background: fixed }), 'the fill is Follow\'s alone');
});

test('explicit dark cues stay dark with the fill on: strobe rests and the Blackout scene', () => {
  for (const fill of ['glow', 'full']) {
    const strobe = run({ effect: presetById('v2.scatterStrobe').spec, background: follow(fill) });
    assert.ok(strobe.some((frame) => lamps(frame).some((lamp) => !dark(lamp))), 'negative control: the strobe flashes');
    assert.ok(strobe.every((frame) => lamps(frame).some(dark)), `${fill}: its rests stay dark`);
    assert.ok(run({ effect: presetById('ldj.Blackout').spec, background: follow(fill) }).every((frame) => frame.every((b) => b === 0)));
  }
});

test('a pad keeps its own black over the main effect with the fill on; only the main effect\'s gaps take its colour', () => {
  const pad = { id: 'pad', spec: chase, targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] };
  const solid = { pattern: 'solid', effect: null, colorA: 0 };
  const asDrawn = run({ ...solid, voices: [pad] });
  for (const fill of ['glow', 'full']) assert.deepEqual(run({ ...solid, background: follow(fill), voices: [pad] }), asDrawn, `${fill}: the pad's gaps are its own black`);
  assert.ok(asDrawn.some((frame) => lamps(frame).some(dark)), 'negative control: the pad leaves lamps dark');
});

test('stopped, Glow shows the main effect\'s colour at the floor where it authored no bed', () => {
  const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => 0, now: 0 });
  const store = createUniverseStore();
  const draw = (now, patch) => {
    renderer.frame(withInputDefaults({ ...look, effect: chase, background: follow('glow'), ...patch }), { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store);
    return lamps([...store.getBuffer(0).slice(0, fixtures.length * 3)]);
  };
  for (const now of [0, 125, 250]) draw(now, {});
  const stopped = draw(500, { programmePlaying: false, running: false });
  for (const lamp of stopped) assert.ok(lamp[0] === 0 && lamp[1] <= 25 && lamp[2] === 0, `${lamp}`);
  assert.ok(stopped.some((lamp) => lamp[1] === 25), 'the whole floor, as Fixed shows its whole colour when stopped');
});

test('the rehearsal preview shows the same fill as the rig', () => {
  const rig = buildRig(fixtures, () => profile);
  for (const background of [follow('glow'), follow('glow', 0.6), follow('full', 0.3)]) {
    const wire = run({ effect: chase, background }, TIMES);
    const preview = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { ...look, pattern: 'chase-effect' } }], null,
      { background, profiles: { [profile.id]: profile }, resolveEffect: (id) => (id === 'chase-effect' ? chase : null), safety: look.safety });
    TIMES.forEach((now, k) => {
      const shown = preview(now, fixtures, COLOR_PRESETS, rig).flatMap((c) => [c.r, c.g, c.b].map(Math.round));
      wire[k].forEach((v, i) => assert.ok(Math.abs(v - shown[i]) <= 1, `${background.followFill} ${background.level} byte ${i} at ${now} ms: ${v}/${shown[i]}`));
    });
  }
});

test('the choice is kept like the other Background settings: Off stores nothing, Glow and Full are saved, recalled and validated', (t) => {
  assert.deepEqual(storedBackground(follow('off')), DEFAULT_BACKGROUND, 'Off stores nothing a build without the fill could not read');
  assert.equal(storedBackground(follow('glow')).followFill, 'glow');
  assert.equal(backgroundSchema.safeParse(follow('bright')).success, false);
  const before = state.background;
  t.after(() => applyPatch({ background: before }));
  applyPatch({ background: follow('full', 0.5) });
  assert.equal(state.background.followFill, 'full');
  assert.equal(captureLook().background.followFill, 'full', 'a cue and the restart record carry it');
  applyPatch({ background: follow('off') });
  assert.equal('followFill' in state.background, false);
});
