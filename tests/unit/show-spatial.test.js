import test from 'node:test';
import assert from 'node:assert/strict';
import LiveDirector from '../../src/show/live-director.ts';
import { MEASURED_LOOKS, SPATIAL_AUTO_PATTERNS, automaticPattern, pickPattern } from '../../src/show/look.ts';
import { PATTERNS } from '../../src/server/presets.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { requiresAcknowledgement } from '../../src/shared/effects/registry.ts';

const patterns = [...PATTERNS, ...SPATIAL_AUTO_PATTERNS];

test('automatic candidate set only offers acknowledged-independent room forms', () => {
  assert.ok(SPATIAL_AUTO_PATTERNS.length > 20);
  for (const { id } of SPATIAL_AUTO_PATTERNS) {
    const p = presetById(id);
    assert.equal(p.spec.params.space, 'room');
    assert.equal(requiresAcknowledgement(p.spec), false);
    assert.ok(!['v2.neural', 'v2.visualizer'].includes(p.spec.kind), 'automatic playback has no guaranteed external audio or picture');
  }
});

test('look picker uses the spatial set while respecting constrained legacy callers', () => {
  const character = { energy: 0.9, kick: 0.9, bassline: 0.9, pulse: 0.9 };
  const spatial = pickPattern({ character, available: new Set(patterns.map((p) => p.id)), drive: 0.9 });
  assert.match(spatial, /^v2\./);
  assert.equal(pickPattern({ character, available: new Set(['chase']), drive: 0.9 }), 'chase');
});

test('live director selects a rising wall for builds and a spatial impact on a drop', () => {
  const patches = [];
  const director = new LiveDirector({ patterns, applyPatch: (p) => patches.push(p), setTimer: () => 1, clearTimer: () => {} });
  director.start();
  director.onEvent({ type: 'BUILDUP', data: {} });
  assert.equal(patches.at(-1).pattern, 'v2.risingWall');
  assert.equal(patches.at(-1).pixelSpan, 16, 'the live build fills once over the wall\'s own sixteen beats, never an analyzed span');
  assert.equal(patches.at(-1).pixelFrom, null);
  director.onEvent({ type: 'DROP', data: {} });
  const drop = patches.findLast((p) => p.pattern);
  // No coverage measured: of the drop's own looks only the shockwave is left, so the pick for a hard passage chooses.
  assert.ok(['v2.speakerShockwave', 'v2.risingWall', 'v2.zones', 'v2.surroundAnswer', 'v2.rotation', 'v2.stemsSpace'].includes(drop.pattern), drop.pattern);
  assert.equal(drop.pixelPattern, null);
  assert.equal(drop.pixelSpan, null);
  assert.equal(drop.pixelFrom, null);
  director.stop();
});

test('live sparse rigs keep drop selection on room-spanning fields, and not on one of them', () => {
  const patches = [], director = new LiveDirector({ patterns, pixels: () => false,
    applyPatch: (p) => patches.push(p), setTimer: () => 1, clearTimer: () => {} });
  director.start();
  for (let i = 0; i < 8; i++) director.onEvent({ type: 'DROP', data: {} });
  director.stop();
  const looks = patches.filter((p) => p.pattern);
  assert.ok(looks.every((p) => presetById(p.pattern)?.spec.kind !== 'v2.particles'));
  // One drop look left (the particle paths are out): the drops do not all land on it.
  assert.ok(new Set(looks.slice(1).map((p) => p.pattern)).size > 1);
});

test('a measured rig plays its usable looks, and an empty measurement leaves every look but the particle paths', () => {
  const usable = new Set(['v2.wash', 'v2.fireworks']);
  for (const { id } of SPATIAL_AUTO_PATTERNS) {
    const particle = presetById(id).spec.kind === 'v2.particles';
    assert.equal(automaticPattern(id), !particle, id);
    assert.equal(automaticPattern(id, new Set()), !particle, `${id} on an empty result`);
    assert.equal(automaticPattern(id, usable), usable.has(id), `${id} on a measured rig`);
  }
  for (const { id } of PATTERNS) assert.equal(automaticPattern(id, usable), true, `${id} is not measured`);
  const available = new Set(patterns.map((p) => p.id));
  for (let seed = 0; seed < 40; seed++) for (const energy of [0.1, 0.5, 0.9]) {
    const id = pickPattern({ available, seed, usable, pixels: seed % 2 === 0, drive: energy, dance: energy,
      character: { energy, kick: energy, pulse: energy, vocal: 1 - energy, hats: seed % 3 / 2 } });
    assert.ok(available.has(id) && (usable.has(id) || !MEASURED_LOOKS.has(id)), `${id} is left to play`);
  }
});

test('the live director keeps to the usable looks on drops and builds, and always has one to play', () => {
  const usable = new Set(['v2.wash', 'v2.chase']);
  const patches = [], director = new LiveDirector({ patterns, pixels: () => true, usablePatterns: () => usable,
    applyPatch: (p) => patches.push(p), setTimer: () => 1, clearTimer: () => {} });
  director.start();
  for (let i = 0; i < 6; i++) {
    director.onEvent({ type: 'BUILDUP', data: {} });
    assert.equal(patches.at(-1).beatDivision, 2, 'a build still doubles the pace');
    director.onEvent({ type: 'DROP', data: {} });
    for (let bar = 0; bar < 16; bar++) director.onEvent({ type: 'BAR', data: {} });
  }
  director.stop();
  const looks = patches.filter((p) => 'pattern' in p);
  assert.ok(looks.length >= 13);
  for (const p of looks) assert.ok(typeof p.pattern === 'string' && (usable.has(p.pattern) || !MEASURED_LOOKS.has(p.pattern)), p.pattern);
});
