import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { baseIntentOf, createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { channelReader } from '../../src/shared/placement.ts';
import { SRGB_DECODE } from '../../src/shared/color.ts';
import { blackPointGain } from '../../src/shared/picture-grade.ts';
import { registerKind, validateSpec } from '../../src/shared/effects/registry.ts';

// A base effect that counts its renders and fresh states. Its colour follows the time since its launch,
// so an instance that resumed after a picture and one that played on underneath draw the same.
const probe = { renders: 0, inits: 0 };
registerKind({
  kind: 'test.pictureProbe', app: 'own', schema: z.object({}).strict(), defaults: { params: {} }, stateful: true,
  init: () => { probe.inits++; return { renders: 0 }; },
  render(_params, s, room, frame, out) {
    probe.renders++;
    s.renders++;
    const t = Math.floor((frame.nowMs - frame.startedAtMs) / 10) % 256;
    for (let i = 0; i < room.n; i++) out[i] = { colour: { r: t, g: (t + 40 * i) % 256, b: 200, w: 0, a: 0, uv: 0 }, level: 1, strength: 1 };
  },
  command() {},
});
registerKind({
  kind: 'test.picturePaint', app: 'own', schema: z.object({}).strict(), defaults: { params: {}, palette: ['#00FF00'] },
  init: () => null,
  render(_params, _state, room, frame, out) {
    for (let i = 0; i < room.n; i++) out[i] = { colour: { ...frame.palette[0] }, level: 1, strength: 1 };
  },
});
const effect = validateSpec({ kind: 'test.pictureProbe' });

// Two RGB pars and one 2 x 1 matrix: the room picture paints every unit without a pixel stream.
const par = { id: 'picture-par', name: 'Par', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const bar = { id: 'picture-bar', name: 'Bar', channelCount: 6, channelMap: {},
  cells: [{ channelMap: { red: 0, green: 1, blue: 2 } }, { channelMap: { red: 3, green: 4, blue: 5 } }] };
const grid = { id: 'picture-grid', name: 'Screen', channelCount: 6, channelMap: {}, grid: { columns: 2, rows: 1 },
  cells: [{ at: { x: 0, y: 0 }, channelMap: { red: 0, green: 1, blue: 2 } }, { at: { x: 1, y: 0 }, channelMap: { red: 3, green: 4, blue: 5 } }] };
const profiles = { [par.id]: par, [bar.id]: bar, [grid.id]: grid };
const fixture = (id, profileId, universe, position) => ({ id, profileId, address: 1, universe, maxBrightness: 255,
  override: null, hue: false, position, group: null, geometry: null, output: { protocol: 'ddp', host: '127.0.0.1' } });
const fixtures = () => [fixture(1, par.id, 1, { x: 10, y: 50 }), fixture(2, bar.id, 2, { x: 50, y: 50 }), fixture(3, grid.id, 3, { x: 90, y: 50 })];
const base = (patch = {}) => ({
  running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, split: null, pixelMap: 'stage',
  beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
  energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
  safety: { acknowledged: true, hdFlashIntervalMs: 350 }, universes: [1, 2, 3], fixtures: fixtures(), ...patch,
});
// Units in rig order: par (1), bar (2), grid (2) = 5 units.
const picture = (data, expiresAt = 2000) => ({ leaseId: 'lease', signature: 'rig', units: 5, expiresAt, data: Uint8Array.from(data) });
const colours = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];
// The picture's bytes drive each unit as sent (no decode, no black point unless the input asks), then the masters.
const sent = (bytes, gain = 1) => bytes.map((v) => Math.round(v * gain));
const linear = (bytes) => bytes.map((v) => Math.round(SRGB_DECODE[v]));
// One unit's three bytes through the black point: the peak sets the gain, all three take it.
const lifted = (bytes, blackPoint, gain = 1) => bytes.map((v) => Math.round(v * blackPointGain(Math.max(...bytes), blackPoint) * gain));

function rig() {
  const store = createUniverseStore(allocateShared());
  const renderer = createRenderer({ profileOf: (f) => profiles[f.profileId], profilesRevision: () => 0, now: 0 });
  const read = (universe, profile) => {
    const r = channelReader(universe, 1, profile, (u) => store.getBuffer(u));
    return (profile.cells ?? [{ channelMap: profile.channelMap }]).flatMap((c) => ['red', 'green', 'blue'].map((k) => r(c.channelMap[k])));
  };
  return { renderer, draw(now, patch = {}) {
    renderer.frame(base(patch), { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store, 0);
    return { par: read(1, par), bar: read(2, bar), grid: read(3, grid) };
  } };
}

test('the picture paints every unit in rig order, including a grid without a pixel stream', () => {
  const r = rig();
  const painted = r.draw(100, { picture: picture(colours) });
  assert.deepEqual(painted.par, colours.slice(0, 3));
  assert.deepEqual(painted.bar, colours.slice(3, 9));
  assert.deepEqual(painted.grid, colours.slice(9));
  const decoded = r.draw(100, { picture: picture(colours), pictureDecode: true });
  assert.deepEqual(decoded.par, linear(colours.slice(0, 3)), 'decode on: the linear light the bytes stand for');
  assert.deepEqual(decoded.bar, linear(colours.slice(3, 9)));
  assert.deepEqual(decoded.grid, linear(colours.slice(9)));
});

test('the black point darkens the units at or under it and ramps the rest, hue kept, before the masters', () => {
  const r = rig(), at = (blackPoint, patch = {}) => r.draw(100, { picture: picture(colours), pictureBlackPoint: blackPoint, ...patch });
  // The par's peak is 30, the threshold byte at 0.12: off. The bar's cells peak at 60 and 90: lifted.
  const lifted12 = at(0.12);
  assert.deepEqual(lifted12.par, [0, 0, 0]);
  assert.deepEqual(lifted12.bar, [...lifted([40, 50, 60], 0.12), ...lifted([70, 80, 90], 0.12)]);
  assert.deepEqual(lifted12.bar, [22, 28, 33, 53, 60, 68]);
  assert.ok(lifted12.bar.every((v, i) => v < colours[3 + i]), 'every lit byte ramps down');
  assert.ok(Math.abs(lifted12.bar[0] / lifted12.bar[2] - 40 / 60) < 0.03 && Math.abs(lifted12.bar[3] / lifted12.bar[5] - 70 / 90) < 0.03, 'the ratios hold');
  assert.deepEqual(at(0.12, { masterDimmer: 128 }).bar, [...lifted([40, 50, 60], 0.12, 128 / 255), ...lifted([70, 80, 90], 0.12, 128 / 255)], 'the master applies after the lift');
  assert.deepEqual(at(0).par, colours.slice(0, 3), 'zero: every byte as sent');
  assert.deepEqual(at(0).bar, colours.slice(3, 9));
  assert.deepEqual(at(0.5).bar, [0, 0, 0, 0, 0, 0], 'half: 90 is under 127.5');
  const bright = picture([255, 128, 0, 31, 0, 0, 200, 100, 50, 0, 0, 0, 0, 0, 0]);
  const lit = r.draw(100, { picture: bright, pictureBlackPoint: 0.12 });
  assert.deepEqual(lit.par, [255, 128, 0], 'a full peak stays as sent');
  assert.deepEqual(lit.bar, [0, 0, 0, ...lifted([200, 100, 50], 0.12)], '31 lights, but rounds to nothing on the wire');

});

test('voices and overrides stay above the picture; the master dimmer and blackout still apply', () => {
  const fx = fixtures();
  fx[0].override = { enabled: true, blackout: false, r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 };
  const out = rig().draw(100, { picture: picture(colours), fixtures: fx });
  assert.deepEqual(out.par, [0, 255, 0]);
  assert.deepEqual(out.bar, colours.slice(3, 9));
  assert.deepEqual(rig().draw(100, { picture: picture(colours), masterDimmer: 128 }).bar, sent(colours.slice(3, 9), 128 / 255));
  assert.deepEqual(rig().draw(100, { picture: picture(colours), masterBlackout: true }).bar, [0, 0, 0, 0, 0, 0]);
});

test('an expired, mis-sized or unacknowledged picture falls back to the effect', () => {
  const r = rig(), plain = r.draw(100);
  assert.deepEqual(r.draw(2000, { picture: picture(colours, 2000) }).par, rig().draw(2000).par);
  assert.deepEqual(r.draw(100, { picture: picture(colours.slice(0, 12)) }).par, plain.par);
  assert.deepEqual(r.draw(100, { picture: picture(colours), safety: { acknowledged: false, hdFlashIntervalMs: 350 } }).par, plain.par);
  assert.deepEqual(r.draw(100, { picture: null }).par, plain.par);
});

test('a live grid stream wins, then an expired or incompatible stream falls back to the room picture', () => {
  const room = picture(colours);
  const stream = { fixtureId: 3, leaseId: 'grid', width: 2, height: 1, expiresAt: 200,
    data: Uint8Array.from([220, 180, 80, 160, 90, 40]) };
  const draw = (now, pixelInputs) => rig().draw(now, { picture: room, pixelInputs });
  assert.deepEqual(draw(100, [stream]).grid, [...stream.data]);
  assert.deepEqual(draw(200, [stream]).grid, colours.slice(9));
  assert.deepEqual(draw(100, [{ ...stream, width: 1, height: 2 }]).grid, colours.slice(9));
  assert.deepEqual(draw(100, [stream]).bar, colours.slice(3, 9));
});

// Under a picture on every unit the base layer is never seen, so it is not drawn; voices and overrides still are.
test('a picture over every unit leaves the base effect undrawn and paints as before', () => {
  const r = rig(), fx = fixtures();
  fx[0].override = { enabled: true, blackout: false, r: 0, g: 0, b: 255, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 };
  const voice = { id: 'paint', spec: validateSpec({ kind: 'test.picturePaint' }), targets: [2], tier: 'voice', launchSeq: 1,
    startedAtMs: 0, untilMs: null, anchorBeat: 0, seed: [1, 2, 3, 4] };
  r.draw(100, { effect });
  const before = probe.renders;
  assert.ok(before > 0, 'the effect plays without a picture');
  for (const now of [125, 150, 175]) {
    const out = r.draw(now, { effect, picture: picture(colours), fixtures: fx, voices: [voice] });
    assert.deepEqual(out.par, [0, 0, 255], 'the override stays above the picture');
    assert.deepEqual(out.bar, [0, 255, 0, 0, 255, 0], 'so does the voice');
    assert.deepEqual(out.grid, colours.slice(9));
  }
  assert.equal(probe.renders, before, 'nothing drew the base effect under the picture');
  // A command due under the picture still reaches the effect's state: that frame draws it.
  r.renderer.command(1, 'toggleDirection', undefined, baseIntentOf({ pattern: 'solid', effect }));
  assert.deepEqual(r.draw(200, { effect, picture: picture(colours) }).bar, colours.slice(3, 9));
  assert.deepEqual(r.renderer.takeCommandResults(), [{ seq: 1, status: 'applied' }]);
  assert.equal(probe.renders, before + 1);
});

// Four seconds under the picture: the stepper drops an instance unseen for two, so only a kept one resumes.
test('after the picture the base effect resumes as if it had played on underneath', () => {
  const frames = Array.from({ length: 121 }, (_, k) => 100 + k * 50);
  const run = (painted) => {
    const r = rig(), inits = probe.inits;
    const out = frames.map((now) => r.draw(now, { effect, ...(painted && now >= 600 ? { picture: picture(colours, 4600) } : {}) }));
    return { out, inits: probe.inits - inits };
  };
  const shown = run(true), played = run(false);
  frames.forEach((now, k) => {
    if (now >= 600 && now < 4600) assert.deepEqual(shown.out[k].bar, colours.slice(3, 9), `the picture at ${now} ms`);
    else assert.deepEqual(shown.out[k], played.out[k], `the effect at ${now} ms`);
  });
  assert.deepEqual([shown.inits, played.inits], [1, 1], 'one state each: the instance outlived the picture');
});

// A browser visualizer that strobes (a MilkDrop preset can) reaches the rig through this path whichever page
// draws it: the per-unit hardware rate limit always, the large-area limiter when it is on.
test('a flashing room picture passes the hardware flash limit and the optional large-area limiter', () => {
  const hardware = { technologies: { ddp: { maxFlashHz: 2, minTransitionMs: 0 } }, products: {} };
  const r = rig(), draw = (now, value) => r.draw(now, { hardware, picture: picture(Array(15).fill(value), now + 2000) }).par;
  assert.deepEqual(draw(0, 255), [255, 255, 255]);
  assert.deepEqual(draw(50, 0), [0, 0, 0]);
  assert.deepEqual(draw(100, 255), [0, 0, 0], 'a second flash within half a second is held dark');
  assert.deepEqual(draw(550, 255), [255, 255, 255]);
  const guarded = rig(), unguarded = rig();
  let changed = false;
  for (let now = 0; now <= 1800; now += 50) {
    const frame = picture(Array(15).fill(now % 100 === 0 ? 255 : 0), now + 2000);
    const a = guarded.draw(now, { picture: frame, flashLimit: true }), b = unguarded.draw(now, { picture: frame, flashLimit: false });
    if (JSON.stringify(a) !== JSON.stringify(b)) changed = true;
  }
  assert.ok(changed, 'the large-area limiter holds a flashing room picture back');
});
