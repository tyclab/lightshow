// G5 of the Show v3 fixes (2026-11-15): an unmet picture source is shown, not masked. The units the chosen source
// owns emit nothing while it has no picture, the Background does not fill them, and every layer above keeps its place.

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { channelReader } from '../../src/shared/placement.ts';
import { registerKind, validateSpec } from '../../src/shared/effects/registry.ts';

registerKind({
  kind: 'test.darkPaint', app: 'own', schema: z.object({}).strict(), defaults: { params: {}, palette: ['#FF0000'] },
  init: () => null,
  render(_params, _state, room, frame, out) {
    for (let i = 0; i < room.n; i++) out[i] = { colour: { ...frame.palette[0] }, level: 1, strength: 1 };
  },
});
const effect = validateSpec({ kind: 'test.darkPaint', palette: ['#FF0000'] });
const voiceOf = (id, targets, colour) => ({ id, spec: validateSpec({ kind: 'test.darkPaint', palette: [colour] }), targets, tier: 'voice',
  launchSeq: 1, startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] });

const par = { id: 'dark-par', name: 'Par', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const bar = { id: 'dark-bar', name: 'Bar', channelCount: 6, channelMap: {},
  cells: [{ channelMap: { red: 0, green: 1, blue: 2 } }, { channelMap: { red: 3, green: 4, blue: 5 } }] };
const grid = { id: 'dark-grid', name: 'Panel', channelCount: 6, channelMap: {}, grid: { columns: 2, rows: 1 },
  cells: [{ at: { x: 0, y: 0 }, channelMap: { red: 0, green: 1, blue: 2 } }, { at: { x: 1, y: 0 }, channelMap: { red: 3, green: 4, blue: 5 } }] };
const profiles = { [par.id]: par, [bar.id]: bar, [grid.id]: grid };
const fixture = (id, profileId, universe) => ({ id, profileId, address: 1, universe, maxBrightness: 255,
  override: null, hue: false, position: null, group: null, geometry: null, output: { protocol: 'ddp', host: '127.0.0.1' } });
const fixtures = () => [fixture(1, par.id, 1), fixture(2, bar.id, 2), fixture(3, grid.id, 3)];
const FIXED = { version: 1, mode: 'fixed', level: 1, colour: { r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0 } };
// Every output fades over 200 ms: the change to dark goes through it like any other change.
const HARDWARE = { technologies: { ddp: { maxFlashHz: 100, minTransitionMs: 200 } }, products: {} };
const base = (patch = {}) => ({
  running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, split: null, pixelMap: 'stage',
  beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
  energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, background: FIXED, hardware: HARDWARE, effect,
  safety: { acknowledged: true, hdFlashIntervalMs: 350 }, universes: [1, 2, 3], fixtures: fixtures(), ...patch,
});
const colours = [200, 100, 50, 40, 80, 160, 250, 10, 10, 10, 250, 10, 90, 90, 200];
const picture = (expiresAt, data = colours) => ({ leaseId: 'lease', signature: 'rig', units: 5, expiresAt, data: Uint8Array.from(data) });
const lit = (bytes) => bytes.some((v) => v > 0);
const zero = (bytes) => bytes.every((v) => v === 0);

function rig() {
  const store = createUniverseStore(allocateShared());
  const renderer = createRenderer({ profileOf: (f) => profiles[f.profileId], profilesRevision: () => 0, now: 0 });
  const read = (universe, profile) => {
    const r = channelReader(universe, 1, profile, (u) => store.getBuffer(u));
    return (profile.cells ?? [{ channelMap: profile.channelMap }]).flatMap((c) => ['red', 'green', 'blue'].map((k) => r(c.channelMap[k])));
  };
  let now = 0, out = null;
  const draw = (patch) => {
    renderer.frame(base(typeof patch === 'function' ? patch(now) : patch), { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store, 0);
    out = { par: read(1, par), bar: read(2, bar), grid: read(3, grid) };
    return out;
  };
  // Frames every 25 ms for `ms`, as the engine sends them; the last frame's output.
  const run = (ms, patch = {}) => {
    const end = now + ms;
    while (now < end) { now += 25; draw(patch); }
    return out;
  };
  return { run, at: () => now };
}

test('room picture: a frame lights the owned units, losing it fades them to exactly zero with Fixed Background on, a fresh frame lights them again', () => {
  const r = rig();
  const painting = (now) => ({ pictureOwns: 'room', picture: picture(now + 2000) });
  const shown = r.run(400, painting);
  assert.ok(lit(shown.par) && lit(shown.bar) && lit(shown.grid), JSON.stringify(shown));
  assert.notDeepEqual(shown.par, [255, 0, 0], 'the picture, not the effect');
  const first = r.run(25, { pictureOwns: 'room', picture: null });
  assert.ok(lit(first.par) && lit(first.bar), 'the configured transition still fades');
  const dark = r.run(400, { pictureOwns: 'room', picture: null });
  assert.deepEqual(dark, { par: [0, 0, 0], bar: [0, 0, 0, 0, 0, 0], grid: [0, 0, 0, 0, 0, 0] }, 'the Background fills no part of the dark');
  const expired = r.run(400, { pictureOwns: 'room', picture: picture(0) });
  assert.ok(zero(expired.par) && zero(expired.bar), 'an expired frame is no frame');
  const again = r.run(400, painting);
  assert.deepEqual(again, shown, 'the same frame lights them as before');
  const effects = r.run(400, { pictureOwns: null, picture: null });
  assert.deepEqual(effects, { par: [255, 0, 0], bar: [255, 0, 0, 255, 0, 0], grid: [255, 0, 0, 255, 0, 0] }, 'Effects plays the selected effect');
});

test('a black frame is still a picture the Fixed colour fills; the dark is not', () => {
  const r = rig();
  const black = r.run(400, (now) => ({ pictureOwns: 'room', picture: picture(now + 2000, Array(15).fill(0)) }));
  assert.deepEqual(black.par, [0, 255, 0]);
  assert.deepEqual(r.run(400, { pictureOwns: 'room', picture: null }).par, [0, 0, 0]);
});

test('voices, pads, overrides and Identify light their units over the dark; Freeze keeps its held light; Blackout wins', () => {
  const r = rig();
  const fx = fixtures();
  fx[0].override = { enabled: true, blackout: false, r: 0, g: 0, b: 255, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 };
  const above = r.run(400, { pictureOwns: 'room', picture: null, fixtures: fx,
    voices: [voiceOf('voice', [2], '#FFFF00'), voiceOf('pad:1:1', [3], '#FF00FF')] });
  assert.deepEqual(above.par, [0, 0, 255], 'the override');
  assert.deepEqual(above.bar, [255, 255, 0, 255, 255, 0], 'the voice');
  assert.deepEqual(above.grid, [255, 0, 255, 255, 0, 255], 'the pad');
  const identify = r.run(200, (now) => ({ pictureOwns: 'room', picture: null, identify: { seq: 1, ids: [3], at: now - 25, ms: 5000 } }));
  assert.ok(lit(identify.grid), 'Identify');
  assert.ok(zero(identify.par) && zero(identify.bar));

  const held = rig();
  const shown = held.run(400, (now) => ({ pictureOwns: 'room', picture: picture(now + 2000) }));
  assert.deepEqual(held.run(400, { pictureOwns: 'room', picture: null, frozen: true }), shown, 'Freeze holds the light it had');
  assert.deepEqual(held.run(100, { pictureOwns: 'room', picture: null, frozen: true, masterBlackout: true }),
    { par: [0, 0, 0], bar: [0, 0, 0, 0, 0, 0], grid: [0, 0, 0, 0, 0, 0] }, 'Blackout over Freeze');
});

test('under the room picture a valid direct stream keeps its panel; an expired one goes dark with the rest', () => {
  const r = rig();
  const stream = (expiresAt) => ({ fixtureId: 3, leaseId: 'grid', width: 2, height: 1, expiresAt, data: Uint8Array.from([220, 180, 80, 160, 90, 40]) });
  const kept = r.run(400, (now) => ({ pictureOwns: 'room', picture: null, pixelInputs: [stream(now + 1000)] }));
  assert.ok(lit(kept.grid), JSON.stringify(kept));
  assert.ok(zero(kept.par) && zero(kept.bar));
  assert.deepEqual(r.run(400, { pictureOwns: 'room', picture: null, pixelInputs: [stream(0)] }).grid, [0, 0, 0, 0, 0, 0]);
});

test('Squid: its panel goes dark without a frame while a lamp beside it keeps the main effect; a frame lights it again; a rig edit moves what it owns', () => {
  const r = rig();
  const frame = (now) => ({ fixtureId: 3, leaseId: 'squid', width: 2, height: 1, expiresAt: now + 1000, data: Uint8Array.from([30, 60, 90, 120, 150, 180]) });
  const playing = r.run(400, (now) => ({ pictureOwns: [3], pixelInputs: [frame(now)] }));
  assert.ok(lit(playing.grid) && playing.grid[0] === 30, JSON.stringify(playing.grid));
  assert.deepEqual(playing.par, [255, 0, 0], 'the lamp beside it plays the main effect');
  const dark = r.run(400, { pictureOwns: [3], pixelInputs: [] });
  assert.deepEqual(dark.grid, [0, 0, 0, 0, 0, 0], 'no frame: dark, not the main effect or the Background');
  assert.deepEqual(dark.par, [255, 0, 0]);
  assert.deepEqual(r.run(400, (now) => ({ pictureOwns: [3], pixelInputs: [frame(now)] })).grid, playing.grid, 'its next frame');
  const moved = r.run(400, { pictureOwns: [1], pixelInputs: [] });
  assert.deepEqual(moved.grid, [255, 0, 0, 255, 0, 0], 'the old panel plays the main effect again');
  assert.deepEqual(moved.par, [0, 0, 0], 'the new owner is dark until its frame');
});
