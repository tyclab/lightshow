import test from 'node:test';
import assert from 'node:assert/strict';
import '../../src/shared/effects/index.ts';
import { RED, BLUE, audioOf, frameAt, renderKind, syntheticRoom } from '../helpers/v2-frames.js';
import { requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';

const GREEN = { r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0 };
const { room } = syntheticRoom();
const lampOf = room.lamps.lampOf;
const render = (kind, params, beat, extra = {}) => renderKind({ kind: `v2.${kind}`, params: { space: 'plan', ...params } }, room, { ...frameAt(beat, extra), ...extra }).out;
const lit = (out) => out.map((slot) => slot.level > 0);

test('step colours take the next palette colour every trigger interval', () => {
  const palette = [RED, BLUE, GREEN];
  const colourAt = (beat, beatInterval) => render('wash', { colour: 'step', trigger: { mode: 'timeline', band: 'full', beatInterval, threshold: 0.15, reactiveDepth: 1 } }, beat, { palette })[0].colour;
  assert.deepEqual([0.5, 1.5, 2.5, 3.5].map((b) => colourAt(b, 1)), [RED, BLUE, GREEN, RED]);
  assert.deepEqual([0.5, 1.5, 2.5].map((b) => colourAt(b, 2)), [RED, RED, BLUE]);
});

test('patch order steps lamp by lamp, one step per lamp, whatever the step count', () => {
  for (const steps of [3, 64]) {
    for (const beat of [0.5, 4.5, 12.5]) {
      const out = render('step', { order: 'patch', steps, stepBeats: 1, trail: 0, envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 } }, beat);
      assert.deepEqual(lit(out), Array.from(lampOf, (lamp) => lamp === Math.floor(beat) % 10), `beat ${beat}, steps ${steps}`);
    }
  }
  const back = render('step', { order: 'patch', direction: 'reverse', stepBeats: 1, trail: 0, envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 } }, 0.5);
  assert.deepEqual(lit(back), Array.from(lampOf, (lamp) => lamp === 9));
});

const HOLD = { curve: 'linear', attack: 0, hold: 1, release: 0 };
const zones = (partition, mode, beat, palette = [RED, BLUE, GREEN]) => render('zones', { partition, mode, stepBeats: 1, envelope: HOLD }, beat, { palette });

test('lamp partitions split the rig by patch order, palette blocks, diagonals and corners', () => {
  const zoneOf = (out) => Array.from(lampOf, (_, i) => out[i].level > 0);
  assert.deepEqual(zoneOf(zones('patch', 'alternate', 0.5, [RED, BLUE])), Array.from(lampOf, (lamp) => lamp % 2 === 0));
  assert.deepEqual(zoneOf(zones('patch', 'alternate', 1.5)), Array.from(lampOf, (lamp) => lamp % 3 === 1));
  // Ten lamps and three colours: blocks of four, four and two lamps.
  assert.deepEqual(zoneOf(zones('blocks', 'alternate', 1.5)), Array.from(lampOf, (lamp) => lamp >= 4 && lamp < 8));
  const channels = room.lamps.channels(4), corners = room.lamps.channels(5);
  assert.deepEqual(zoneOf(zones('diagonals', 'alternate', 1.5)), Array.from(lampOf, (lamp) => channels[lamp] % 2 === 1));
  assert.deepEqual(zoneOf(zones('corners', 'fill', 1.5)), Array.from(lampOf, (lamp) => corners[lamp] <= 1));
});

test('halves split front from back on even steps and left from right on odd ones', () => {
  const depth = room.lamps.halves('depth'), width = room.lamps.halves('width');
  assert.deepEqual(lit(zones('halves', 'alternate', 0.5)), Array.from(lampOf, (lamp) => depth[lamp] === 1));
  assert.deepEqual(lit(zones('halves', 'alternate', 1.5)), Array.from(lampOf, (lamp) => width[lamp] === 1));
});

test('swap lights every zone in a colour of its own and moves every zone one colour per step', () => {
  const halves = (beat) => zones('halves', 'swap', beat).map((slot) => slot.colour);
  const depth = room.lamps.halves('depth'), width = room.lamps.halves('width');
  assert.deepEqual([0.5, 1.5, 2.5, 3.5].map((beat) => halves(beat)[0]),
    [[1 - depth[0], RED, BLUE], [width[0], RED, BLUE], [1 - depth[0], BLUE, RED], [width[0], BLUE, RED]].map(([side, a, b]) => (side ? b : a)),
    'halves swap their two colours after both splits have played');
  for (const beat of [0.5, 1.5, 2.5]) {
    const out = zones('blocks', 'swap', beat);
    assert.ok(out.every((slot) => slot.level === 1), `beat ${beat}`);
    const step = Math.floor(beat);
    for (const [i, lamp] of lampOf.entries()) {
      const block = Math.min(2, Math.floor(lamp / 4));
      assert.deepEqual(out[i].colour, [RED, BLUE, GREEN][(block + step) % 3], `beat ${beat}, unit ${i}`);
    }
  }
});

test('cover fills zone by zone in the next colour over the colour of the lap before', () => {
  const corners = room.lamps.channels(5);
  const colours = (beat) => zones('corners', 'cover', beat).map((slot) => slot.colour);
  // Five corners: beats 0-4 are lap 0 in red over lap -1's green, beats 5-9 lap 1 in blue over red.
  for (const [beat, fresh, last] of [[0.5, RED, GREEN], [3.5, RED, GREEN], [6.5, BLUE, RED]]) {
    const active = Math.floor(beat) % 5;
    assert.deepEqual(colours(beat), Array.from(lampOf, (lamp) => (corners[lamp] <= active ? fresh : last)), `beat ${beat}`);
  }
  assert.ok(zones('corners', 'cover', 2.5).every((slot) => slot.level === 1));
});

test('shell sparks light a share of the room with each launch and fade over the interval', () => {
  const ring = { origin: 'centre', profile: 'ring', speed: 2, width: 0.2 };
  const plain = render('shell', ring, 0.1).map((slot) => slot.level);
  assert.deepEqual(render('shell', { ...ring, sparks: 0 }, 0.1).map((slot) => slot.level), plain);
  const all = render('shell', { ...ring, sparks: 1 }, 0.1, { palette: [RED, BLUE, GREEN] });
  assert.ok(all.every((slot) => slot.level >= Math.exp(-0.5) - 1e-9));
  assert.ok(all.some((slot, i) => slot.level > plain[i] && slot.colour.g === 255), 'sparks take the last palette colour');
  const share = (beat) => render('shell', { ...ring, sparks: 0.3 }, beat).filter((slot, i) => slot.level > plain[i] + 1e-9).length;
  assert.ok(share(0.1) > 20 && share(0.1) < 70, `${share(0.1)} of 134 spark`);
  const late = render('shell', { ...ring, sparks: 1 }, 0.9).map((slot) => slot.level), early = all.map((slot) => slot.level);
  assert.ok(late.filter((v, i) => v < early[i]).length > room.n / 2, 'sparks fade over the interval');
  const rapid = (params) => requiresAcknowledgement(validateSpec({ kind: 'v2.shell', params: { ...ring, ...params } }));
  assert.deepEqual([rapid({}), rapid({ sparks: 0.2 }), rapid({ sparks: 0.2, trigger: { mode: 'timeline', band: 'full', beatInterval: 2, threshold: 0.15, reactiveDepth: 1 } })], [false, true, false]);
  const fresh = (beat) => render('shell', { ...ring, sparks: 0.3 }, beat).map((slot) => slot.level > 0.4);
  assert.notDeepEqual(fresh(0.1), fresh(0.35), 'drawn afresh every quarter interval');
});

test('neural columns stand the bands side by side and centre throws the bass out from the middle', () => {
  const across = room.X;
  const columns = render('neural', { layout: 'columns', pitchColour: false, smoothing: 0 }, 0, { audio: audioOf({ full: 1, bass: 1 }) });
  for (let i = 0; i < room.n; i++) assert.equal(columns[i].level > 0, across[i] < 1 / 3, `unit ${i}`);
  const quiet = render('neural', { layout: 'centre', pitchColour: false, smoothing: 0 }, 0, { audio: audioOf({ full: 1, mid: 1 }) });
  for (let i = 0; i < room.n; i++) assert.equal(quiet[i].level > 0, Math.abs(across[i] - 0.5) * 2 > 0.55, `unit ${i}`);
  const kick = render('neural', { layout: 'centre', pitchColour: false, smoothing: 0 }, 0, { audio: audioOf({ full: 1, bass: 1 }) });
  for (let i = 0; i < room.n; i++) if (Math.abs(across[i] - 0.5) * 2 < 0.95) assert.ok(kick[i].level > 0, `a full kick reaches unit ${i}`);
  const soft = render('neural', { layout: 'centre', pitchColour: false, smoothing: 0 }, 0, { audio: audioOf({ full: 0.2, bass: 0.2 }) });
  for (let i = 0; i < room.n; i++) if (Math.abs(across[i] - 0.5) * 2 > 0.32) assert.equal(soft[i].level, 0, `a soft kick stays in the middle, unit ${i}`);
});
