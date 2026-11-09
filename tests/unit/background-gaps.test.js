// "Between effect hits": an effect reveals the Background layer in its gaps (the default)
// or keeps them dark (spec.background.gaps). Beds and explicit dark cues do not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, withInputDefaults } from '../../src/server/renderer.ts';
import { createUniverseStore } from '../../src/server/universes.ts';
import { DEFAULT_GAPS, KINDS, chooseGaps, gapsApply, gapsOf, strobeRests, validateSpec } from '../../src/shared/effects/registry.ts';
import { CATALOGUE, presetById } from '../../src/shared/effects/index.ts';
import { HD_DEFAULTS } from '../../src/shared/effects/hd.ts';
import { bundleSpec } from '../../src/shared/effects/bundle.ts';
import { DEFAULT_BACKGROUND, composeBackground } from '../../src/shared/background.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { harness, row, square } from '../helpers/ldj-harness.js';
import { parseHex } from '../../src/shared/effects/palette.ts';

const emitters = ['red', 'green', 'blue', 'white', 'amber', 'uv'];
const profile = { id: 'six-emitter-gaps', channelCount: 6, channelMap: Object.fromEntries(emitters.map((c, i) => [c, i])) };
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
const with_ = (spec, gaps) => validateSpec({ ...spec, background: { ...spec.background, gaps } });
const run = (patch, times) => { const e = engine(patch); return times.map((now) => e.draw(now)); };
const TIMES = [0, 125, 250, 375, 500, 750, 1000, 1250, 1500, 2000];

test('every family reveals the Background layer by default; Keep dark is a stored choice', () => {
  assert.equal(DEFAULT_GAPS, 'reveal');
  for (const kind of ['ldj.FadeCycle', 'ldj.bitmap', 'hd.disco', 'hd.twinkle', 'v2.scatter']) assert.equal(gapsOf(validateSpec({ kind })), 'reveal', kind);
  const spec = validateSpec({ kind: 'ldj.FadeCycle' });
  assert.equal(spec.background.gaps, undefined, 'a fresh spec stores no choice: it takes the default');
  assert.equal(gapsOf(with_(spec, 'dark')), 'dark');
  assert.equal(gapsOf(spec, 'dark'), 'dark', 'an enclosing macro’s choice reaches a spec that makes none');
  assert.equal(gapsOf(with_(spec, 'reveal'), 'dark'), 'reveal', 'the spec’s own choice wins');
  assert.deepEqual(validateSpec(with_(spec, 'dark')).background, { version: 1, level: 1, gaps: 'dark' });
  assert.throws(() => validateSpec({ ...spec, background: { version: 1, level: 1, gaps: 'maybe' } }));
  assert.throws(() => validateSpec({ ...spec, background: { version: 1, level: 1, between: 'dark' } }));
});

test('every catalogue effect renders the same with no choice stored as with the default chosen', () => {
  for (const preset of CATALOGUE) {
    if (preset.legacy || !preset.spec) continue;
    const explicit = with_(preset.spec, gapsOf(preset.spec));
    for (const background of [fixed, off]) {
      assert.deepEqual(run({ effect: explicit, background }, [0, 250, 900]), run({ effect: preset.spec, background }, [0, 250, 900]),
        `${preset.id} under ${background.mode}`);
    }
  }
});

test('an Entertainment chase reveals the Fixed colour in its gaps by default and keeps them dark when asked', () => {
  const spec = validateSpec({ kind: 'ldj.FadeCycle', palette: ['#FF0000', '#00FF00'] });
  const kept = run({ effect: with_(spec, 'dark'), background: fixed }, TIMES), revealed = run({ effect: spec, background: fixed }, TIMES);
  let filled = 0;
  revealed.forEach((frame, k) => lamps(frame).forEach((lamp, i) => {
    const before = lamps(kept[k])[i];
    if (dark(before)) { assert.deepEqual(lamp, WASH, `an unlit lamp ${i} at ${TIMES[k]} ms takes the whole wash`); filled++; }
    else assert.ok(lamp.every((byte, c) => byte >= before[c]), 'a lit lamp only gains the uncovered share');
  }));
  assert.ok(filled >= 10, `negative control: the chase leaves unlit lamps (${filled})`);
  assert.deepEqual(run({ effect: spec, background: off }, TIMES), run({ effect: with_(spec, 'dark'), background: off }, TIMES), 'Off: Reveal changes nothing');
  // Follow fills the same gaps with the effect's own first colour (red) at the floor, 25 of 255 at 100 %.
  for (const background of [follow, DEFAULT_BACKGROUND]) {
    const keptFollow = run({ effect: with_(spec, 'dark'), background }, TIMES);
    run({ effect: spec, background }, TIMES).forEach((frame, k) => lamps(frame).forEach((lamp, i) => {
      if (dark(lamps(keptFollow[k])[i])) assert.deepEqual(lamp, [Math.round(25 * background.level), 0, 0, 0, 0, 0], `Follow ${background.level}: lamp ${i} at ${TIMES[k]} ms`);
    }));
  }
});

test('explicit dark cues stay dark under Reveal: strobe rests, a black foreground, the Blackout scene', () => {
  const strobe = with_(validateSpec({ kind: 'ldj.ScatterStrobe' }), 'reveal');
  const frames = run({ effect: strobe, background: fixed, paletteOverride: null }, TIMES);
  assert.ok(frames.some((frame) => lamps(frame).some((lamp) => !dark(lamp))), 'negative control: the strobe flashes');
  for (const frame of frames) for (const lamp of lamps(frame)) assert.ok(dark(lamp) || !lamp.every((byte, c) => byte === WASH[c]), 'a rest is never filled');
  assert.ok(frames.every((frame) => lamps(frame).filter(dark).length >= 6), 'the rapid rests stay dark');

  const black = with_(validateSpec({ kind: 'ldj.FadeCycle', palette: ['#000000'] }), 'reveal');
  const covered = run({ effect: black, background: fixed }, [0, 30]);
  const lit = lamps(covered[1]).filter((lamp) => !dark(lamp)).length;
  assert.ok(lit > 0 && lit < 8, 'negative control: unlit lamps reveal the wash');

  const scene = presetById('ldj.Blackout').spec;
  for (const spec of [with_(scene, 'reveal'), scene]) assert.ok(run({ effect: spec, background: fixed }, TIMES).every(dark), 'the Blackout scene owns black');
});

test('Disco reveals the unlit share of its lamps unless kept dark; its idle and release beds do not change', () => {
  const audio = (t, amplitude) => ({ t, generation: 1, party: { full: 1, bass: 1, mid: 1, high: 1 }, spl: null,
    disco: { neural: { mainFrequency: .5, amplitude } } });
  const slots = (gaps) => {
    const h = harness('hd.disco', row(4), { params: { style: 'neural' }, spec: gaps ? { background: { version: 1, level: 1, gaps } } : {} });
    h.draw({ nowMs: 0, beatPos: 0, audioMode: 'reactive', audio: audio(0, .2) });
    return h.draw({ nowMs: 100, beatPos: .2, audioMode: 'reactive', audio: audio(.1, .2) });
  };
  for (const slot of slots('dark')) assert.equal(slot.background, undefined, 'Keep dark publishes no field for a Neural lamp');
  assert.deepEqual(slots(), slots('reveal'), 'Reveal is the default');
  for (const slot of slots('reveal')) {
    assert.ok(Math.abs(slot.level - .2) < .01, 'negative control: the lamp plays the amplitude');
    assert.ok(Math.abs(slot.background.coverage - .8) < .01, 'the unlit share is a gap');
    assert.equal(slot.background.level, 0, 'a gap has no authored light');
    const shown = composeBackground(slot.colour, slot.level, slot.background, fixed);
    assert.ok(Math.abs(shown.level - (.2 + .3 * .8)) < .01);
  }
  const idle = harness('hd.disco', row(4), { params: { style: 'neural' }, spec: { background: { version: 1, level: 1, gaps: 'reveal' } } });
  const plain = harness('hd.disco', row(4), { params: { style: 'neural' }, spec: { background: { version: 1, level: 1, gaps: 'dark' } } });
  const draw = (h, nowMs) => h.draw({ nowMs, beatPos: nowMs / 500 });
  assert.deepEqual(draw(idle, 0), draw(plain, 0), 'a lamp the Disco has not reached is the layer below’s, not a gap');
  for (const nowMs of [2100, 3000, 3600]) {
    const revealed = draw(idle, nowMs), kept = draw(plain, nowMs);
    revealed.forEach((slot, i) => {
      const bed = kept[i].background ?? { coverage: 0, level: 0 };
      assert.equal(slot.background.level, bed.level, 'the idle bed keeps its authored light');
      assert.ok(Math.abs(slot.background.coverage - (bed.coverage + (1 - bed.coverage) * (1 - slot.level))) < 1e-9, 'plus the unlit share');
      const light = (shown) => ['r', 'g', 'b', 'w', 'a', 'uv'].map((k) => (shown.colour[k] ?? 0) * shown.level);
      for (const background of [follow, off]) {
        const a = light(composeBackground(slot.colour, slot.level, slot.background, background));
        light(composeBackground(slot.colour, slot.level, kept[i].background, background)).forEach((v, c) => assert.ok(Math.abs(v - a[c]) < 1e-6, background.mode));
      }
    });
  }
});

test('a bitmap’s black background is a gap: filled by default, dark when kept dark, dark again when scrolled rapidly', () => {
  const spec = validateSpec({ kind: 'ldj.bitmap', params: { pattern: 'SolidBlackBGSineWave' } });
  const kept = run({ effect: with_(spec, 'dark'), background: fixed }, [0, 500]), revealed = run({ effect: spec, background: fixed }, [0, 500]);
  let filled = 0;
  revealed.forEach((frame, k) => lamps(frame).forEach((lamp, i) => {
    if (dark(lamps(kept[k])[i])) { assert.deepEqual(lamp, WASH); filled++; }
  }));
  assert.ok(filled > 0, 'negative control: the raster has black background lamps');
  assert.deepEqual(run({ effect: spec, background: off }, [0, 500]), run({ effect: with_(spec, 'dark'), background: off }, [0, 500]), 'off');
  const followed = run({ effect: spec, background: follow }, [0, 500]), keptFollow = run({ effect: with_(spec, 'dark'), background: follow }, [0, 500]);
  assert.ok(followed.some((frame, k) => lamps(frame).some((lamp, i) => dark(lamps(keptFollow[k])[i]) && !dark(lamp))), 'Follow fills the black background');
  const rapid = with_(validateSpec({ kind: 'ldj.bitmap', params: { pattern: 'SolidBlackBGSineWave', speed: 3 } }), 'reveal');
  assert.deepEqual(run({ effect: rapid, background: fixed }, [0, 500]),
    run({ effect: with_(rapid, 'dark'), background: fixed }, [0, 500]), 'a rapid raster’s black is a strobe rest');
});

const hdGap = (over = {}) => validateSpec({ kind: 'hd.twinkle', brightness: 1, ...over,
  params: { ...HD_DEFAULTS['hd.twinkle'].params, probability: 0, trigger: { ...HD_DEFAULTS['hd.twinkle'].params.trigger, mode: 'timeline' } } });

test('Keep dark on a Party & Disco or V2 effect leaves its gaps black but still replaces an authored bed', () => {
  assert.ok(run({ effect: hdGap(), background: fixed }, [0, 500]).every((frame) => lamps(frame).every((lamp) => lamp.join() === WASH.join())),
    'negative control: by default the Party & Disco gap reveals the wash');
  assert.ok(run({ effect: with_(hdGap(), 'dark'), background: fixed }, [0, 500]).every(dark));
  const v2 = validateSpec({ kind: 'v2.scatter', params: { density: 0, background: 0 } });
  assert.ok(!run({ effect: v2, background: fixed }, [0, 500]).every(dark), 'negative control: V2 gaps reveal by default');
  assert.ok(run({ effect: with_(v2, 'dark'), background: fixed }, [0, 500]).every(dark));
  const bed = with_(validateSpec({ kind: 'v2.scatter', params: { density: 0, background: .4, backgroundColour: '#FF0000' } }), 'dark');
  assert.ok(run({ effect: bed, background: fixed }, [0, 500]).every((frame) => lamps(frame).every((lamp) => lamp.join() === WASH.join())),
    'the authored bed is the background layer: Fixed replaces it under Keep dark too');
  assert.ok(run({ effect: bed, background: off }, [0, 500]).every(dark), 'and Off removes it');
});

test('a macro’s choice reaches steps that make none; a step’s own choice wins', () => {
  const step = (gaps) => ({ beats: 4, effect: gaps ? with_(validateSpec({ kind: 'ldj.FadeCycle' }), gaps) : { kind: 'ldj.FadeCycle', params: {} } });
  const macro = (gaps, stepGaps) => validateSpec({ kind: 'macro', params: { steps: [step(stepGaps)], loopBeats: 4 },
    ...(gaps ? { background: { version: 1, level: 1, gaps } } : {}) });
  const unlit = (spec) => run({ effect: spec, background: fixed }, TIMES).flatMap(lamps).filter(dark).length;
  assert.equal(unlit(macro()), 0, 'by default the step reveals its gaps');
  assert.ok(unlit(macro('dark')) > 10, 'the macro keeps its step’s gaps dark');
  assert.equal(unlit(macro('dark', 'reveal')), 0, 'a step’s explicit Reveal wins');
  assert.ok(unlit(macro(undefined, 'dark')) > 10, 'a step’s explicit Keep dark plays inside a macro that chose nothing');
});

test('a pattern pad and a sequence clip reveal an Entertainment clip’s gaps unless the clip keeps them dark; the look beneath never shows through', () => {
  const clip = (gaps) => {
    const spec = validateSpec({ kind: 'ldj.FadeCycle', palette: ['#FF0000'] });
    return { id: 'c', laneId: 'l', fixtureIds: null, startBeat: 0, lengthBeats: 4, loopBeats: 4, spec: gaps ? with_(spec, gaps) : spec, seed: [1, 2, 3, 4], mute: false };
  };
  const table = (gaps) => ({ revision: 1, lanes: [{ id: 'l', kind: 'shared', name: 'l', mute: false, solo: false }], clips: [clip(gaps)] });
  const pad = (gaps) => ({ id: 'pad', spec: validateSpec(bundleSpec({ patternId: 'p', lengthBeats: 4, table: table(gaps) }, false), { internal: true }),
    targets: null, tier: 'voice', launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] });
  const padded = (gaps, background) => engine({ background }).draw(250, { voices: [pad(gaps)] });
  assert.ok(lamps(engine().draw(250)).every((lamp) => !dark(lamp)), 'negative control: the solid base lights every lamp');
  assert.ok(lamps(padded(undefined, DEFAULT_BACKGROUND)).filter(dark).length >= 4, 'the pad’s gaps are its own black, not the look beneath');
  assert.ok(lamps(padded('dark', fixed)).filter(dark).length >= 4, 'a clip that keeps its gaps dark keeps the pad’s own black');
  for (const gaps of [undefined, 'reveal']) {
    assert.ok(lamps(padded(gaps, fixed)).filter((lamp) => lamp.join() === WASH.join()).length >= 4, `${gaps ?? 'default'}: the clip fills the pad gaps`);
  }
  const e = engine({ background: fixed });
  e.renderer.setSequence(table('reveal'));
  const sequenceTransport = { startBeat: 0, generation: 0, loop: null };
  e.draw(0, { sequenceRevision: 1, sequenceTransport });
  assert.ok(lamps(e.draw(250, { sequenceRevision: 1, sequenceTransport })).filter((lamp) => lamp.join() === WASH.join()).length >= 4);
});

test('the rehearsal preview reveals the same gaps as the renderer', () => {
  const rig = buildRig(fixtures, () => profile);
  const effects = [with_(validateSpec({ kind: 'ldj.FadeCycle' }), 'reveal'), with_(validateSpec({ kind: 'ldj.bitmap', params: { pattern: 'SolidBlackBGTriangleWave' } }), 'reveal'),
    with_(hdGap(), 'dark')];
  for (const effect of effects) for (const background of [fixed, { ...fixed, fixtures: 'selected', selected: [1, 2, 5] }]) {
    const e = engine({ pattern: 'gaps-test', effect, background, paletteOverride: null });
    const preview = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { ...look, pattern: 'gaps-test', paletteOverride: null } }], null,
      { background, profiles: { [profile.id]: profile }, resolveEffect: () => effect, safety: look.safety });
    for (let tick = 0; tick < 30; tick++) {
      const now = tick * 1000 / 44;
      const wire = e.draw(now), shown = preview(now, fixtures, COLOR_PRESETS, rig).flatMap((c) => ['r', 'g', 'b', 'w', 'a', 'uv'].map((k) => c[k] ?? 0));
      wire.forEach((value, index) => assert.ok(Math.abs(value - shown[index]) <= 1, `${effect.kind} byte ${index} at ${now}: ${value}/${shown[index]}`));
    }
  }
});

test('a Disco whose automatic strobe can flash keeps its strobe rests dark under Reveal', () => {
  const audio = (t, hit) => ({ t, generation: 1, party: { full: 1, bass: 1, mid: 1, high: 1 }, spl: null, disco: { peakHit: hit } });
  const play = (gaps) => {
    const h = harness('hd.disco', row(1), { params: { style: 'peak' }, spec: { background: { version: 1, level: 1, gaps } } });
    h.inst.spec.params.channels[3].strobeOn = true;
    h.draw({ nowMs: 0, beatPos: 0, audioMode: 'reactive', audio: audio(0, false), acknowledged: true });
    const shown = [];
    for (let ms = 100; ms <= 1500; ms += 50) {
      const [slot] = h.draw({ nowMs: ms, beatPos: ms / 500, audioMode: 'reactive', audio: audio(ms / 1000, ms % 400 === 100), acknowledged: true });
      const light = composeBackground(slot.colour, slot.level, slot.background, fixed);
      shown.push([light.level, light.colour.r, light.colour.g]);
    }
    return shown;
  };
  const kept = play('dark');
  assert.ok(kept.some(([level]) => level > .9) && kept.some(([level]) => level < .2), 'negative control: the strobe flashes and rests');
  assert.deepEqual(play('reveal'), kept, 'the rests between automatic flashes are strobe rests');
});

test('a revealed bitmap black background emits nothing under Off, and at most the floor under Follow, on dimmer-only and colour lamps', () => {
  const dimmerOnly = { id: 'gaps-dimmer', channelCount: 1, channelMap: { dimmer: 0 } };
  const rgbd = { id: 'gaps-rgbd', channelCount: 4, channelMap: { red: 0, green: 1, blue: 2, dimmer: 3 } };
  const profiles = { [dimmerOnly.id]: dimmerOnly, [rgbd.id]: rgbd };
  const rigOf = (profileOf) => Array.from({ length: 8 }, (_, id) => ({ ...fixtures[id], address: id * 4 + 1, profileId: profileOf(id) }));
  const mixed = rigOf((id) => (id % 2 ? rgbd.id : dimmerOnly.id)), colourOnly = rigOf(() => rgbd.id);
  const draw = (rig, effect, background) => {
    const renderer = createRenderer({ profileOf: (f) => profiles[f.profileId], profilesRevision: () => 0, now: 0 });
    const store = createUniverseStore();
    return [0, 500].map((now) => {
      renderer.frame(withInputDefaults({ ...look, fixtures: rig, effect, background }), { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store);
      return [...store.getBuffer(0).slice(0, 32)];
    });
  };
  const lamp = (rig, frame, id) => frame.slice(id * 4, id * 4 + (rig[id].profileId === rgbd.id ? 4 : 1));
  const revealed = validateSpec({ kind: 'ldj.bitmap', params: { pattern: 'SolidBlackBGSineWave' } }), spec = with_(revealed, 'dark');
  // Which lamps sit on the black background, read from colour lamps in the same places.
  const black = draw(colourOnly, spec, DEFAULT_BACKGROUND).map((frame) => colourOnly.map((_, id) => lamp(colourOnly, frame, id).slice(0, 3).every((b) => b === 0)));
  const keptFull = draw(mixed, spec, DEFAULT_BACKGROUND);
  assert.ok(keptFull.some((frame, k) => mixed.some((f, id) => black[k][id] && f.profileId === dimmerOnly.id && lamp(mixed, frame, id)[0] === 255)),
    'negative control and README known limitation: Keep dark at Follow 100 % keeps main’s full dimmer on black pixels');
  for (const background of [DEFAULT_BACKGROUND, follow, off]) {
    const after = draw(mixed, revealed, background), before = draw(mixed, spec, background);
    const floor = background.mode === 'off' ? 0 : Math.ceil(25 * background.level);
    after.forEach((frame, k) => mixed.forEach((_, id) => {
      if (black[k][id]) assert.ok(lamp(mixed, frame, id).every((b) => b <= floor), `${background.mode} ${background.level}: black lamp ${id} at most the floor`);
      else assert.deepEqual(lamp(mixed, frame, id), lamp(mixed, before[k], id), `${background.mode} ${background.level}: lamp ${id} unchanged`);
    }));
  }
  const filled = draw(mixed, revealed, fixed);
  assert.ok(filled.some((frame, k) => mixed.some((_, id) => black[k][id] && lamp(mixed, frame, id).some((b) => b > 0))), 'Fixed still fills the gap');
});

test('the choice is offered only where it can change the output', () => {
  const on = (raw) => gapsApply(validateSpec(raw));
  for (const raw of [{ kind: 'ldj.FadeCycle' }, { kind: 'hd.twinkle' }, { kind: 'v2.scatter', params: { background: 0 } }, { kind: 'hd.disco' },
    { kind: 'ldj.bitmap', params: { pattern: 'SolidBlackBGSineWave' } }, { kind: 'ldj.bitmap', params: { pattern: 'VertLines' } },
    { kind: 'ldj.bitmap', params: { pattern: 'OGGrooveWave' } }, { kind: 'ldj.matrixBoard', params: { mode: 'cycle', colours: ['#FFFFFF'] } },
    { kind: 'ldj.GrooveWave' }, { kind: 'ldj.Impact' }, { kind: 'ldj.Swirl' }, { kind: 'ldj.Beacon' },
    { kind: 'macro', params: { steps: [{ beats: 4, effect: { kind: 'ldj.FadeCycle', params: {} } }], loopBeats: 4 } }]) assert.ok(on(raw), raw.kind);
  for (const raw of [{ kind: 'strobe' }, { kind: 'energy.glow' }, { kind: 'energy.kill' }, { kind: 'ldj.StudioN1' }, { kind: 'ldj.visualizer' }, { kind: 'ldj.BLFadeCycle' },
    { kind: 'ldj.Rotation' }, { kind: 'ldj.Perlin' }, { kind: 'ldj.BigRoomWave' }, { kind: 'ldj.ScatterStrobe' }, { kind: 'hd.frequencyBurst' }, { kind: 'hd.twinkle', rapidFlash: true },
    { kind: 'v2.neural', params: { idle: .2 } }, { kind: 'v2.scatter', params: { background: .3 } }, { kind: 'ldj.bitmap', params: { pattern: 'SmoothLoop' } },
    { kind: 'ldj.bitmap', params: { pattern: 'SolidBlackBGSineWave', speed: 3 } }, { kind: 'ldj.matrixBoard', params: { mode: 'solid', colours: ['#FFFFFF'] } }])
    assert.ok(!on(raw), raw.kind);
  const disco = validateSpec({ kind: 'hd.disco' });
  assert.ok(!gapsApply({ ...disco, params: { ...disco.params, allowStrobe: true } }), 'a Disco that paces its own strobe');
  assert.ok(!gapsApply(presetById('ldj.Blackout').spec), 'the Blackout scene');
  for (const preset of CATALOGUE) {
    if (preset.legacy || !preset.spec || gapsApply(preset.spec)) continue;
    for (const background of [fixed, { ...fixed, level: 1 }]) {
      assert.deepEqual(run({ effect: with_(preset.spec, 'reveal'), background }, [0, 250, 900, 2000]),
        run({ effect: with_(preset.spec, 'dark'), background }, [0, 250, 900, 2000]), `${preset.id}: disabled, so both choices must play alike`);
    }
  }
});

test('an Entertainment row is marked gapless exactly when no palette or room makes it publish a gap', () => {
  const palettes = [['#FF0000'], ['#FF0000', '#00FF00'], ['#FF0000', '#00FF00', '#0000FF']].map((p) => p.map(parseHex));
  for (const [kind, def] of KINDS) {
    if (!kind.startsWith('ldj.') || !('cadence' in (def.defaults.params ?? {}))) continue;
    const spec = with_(validateSpec({ kind }), 'reveal');
    if (strobeRests(spec)) { assert.ok(!gapsApply(spec), `${kind}: strobe rests`); continue; }
    let gaps = 0;
    for (const palette of palettes) for (const room of [row(1), row(4), row(7), square()]) {
      const h = harness(kind, room, { palette, spec: { background: spec.background } });
      for (let beat = 0; beat <= 16 && !gaps; beat += .25) {
        for (const slot of h.draw(beat)) if (slot.background && !slot.background.dark && !(slot.background.fullLevel > 0) && slot.background.coverage > 0) gaps++;
      }
    }
    assert.equal(gapsApply(spec), gaps > 0, `${kind}: ${gaps ? 'publishes gaps' : 'never leaves a gap'}`);
  }
});

test('picking the default stores no choice, so an enclosing macro’s choice still reaches the effect', () => {
  const fade = validateSpec({ kind: 'ldj.FadeCycle', brightness: .6 });
  assert.deepEqual(chooseGaps(fade, 'dark'), { version: 1, level: .6, gaps: 'dark' });
  assert.deepEqual(chooseGaps(with_(fade, 'dark'), 'reveal'), { version: 1, level: .6 }, 'Reveal is the default: no choice');
  const twinkle = validateSpec({ kind: 'hd.twinkle' });
  assert.deepEqual(chooseGaps(twinkle, 'reveal'), twinkle.background);
  assert.deepEqual(chooseGaps(twinkle, 'dark'), { ...twinkle.background, gaps: 'dark' });
  const macro = validateSpec({ kind: 'macro', params: { steps: [{ beats: 4, effect: { kind: 'ldj.FadeCycle', params: {} } }], loopBeats: 4 } });
  assert.equal(chooseGaps(macro, 'reveal').gaps, 'reveal', 'a macro has no default: each pick is a choice');
  assert.equal(chooseGaps(with_(macro, 'reveal'), '').gaps, undefined, '“Each step’s own” is no choice');
  const inside = validateSpec({ ...macro, background: { version: 1, level: 1, gaps: 'dark' },
    params: { ...macro.params, steps: [{ beats: 4, effect: validateSpec({ kind: 'ldj.FadeCycle', background: chooseGaps(with_(fade, 'dark'), 'reveal') }) }] } });
  const unlit = run({ effect: inside, background: fixed }, TIMES).flatMap(lamps).filter(dark).length;
  assert.ok(unlit > 10, 'the step picked back to the default follows the macro’s Keep dark again');
});
