import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { measureLookCoverage, LookCoverage } from '../../src/server/look-coverage.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { syntheticRig, syntheticSpace } from '../../scripts/golden-frames.js';
import { MEASURED_LOOKS, availableFor } from '../../src/show/look.ts';
import { kindOf } from '../../src/shared/effects/registry.ts';
import { V2_PRESETS } from '../../src/shared/effects/v2/presets.ts';
import { effectRoom, voiceLayout } from '../../src/shared/effects/layer.ts';
import { runtimeRig } from '../helpers/runtime-rig.js';

function pointsRoom(points) {
  const room = buildRoom(points.length, (i) => (points[i][0] + 2) / 4, (i) => (points[i][2] + 2) / 4, () => 0.5, null);
  room.space = { x: Float32Array.from(points, (p) => p[0]), y: Float32Array.from(points, (p) => p[1]),
    z: Float32Array.from(points, (p) => p[2]), size: new Float32Array(points.length).fill(0.02),
    bounds: { width: 4, depth: 4, height: 4 }, listener: { x: 0, y: 1.2, z: 0, facingDeg: 0 }, anchors: {} };
  return room;
}

test('a corner pixel pair does not qualify while well-placed whole lamps do', async () => {
  const corner = await measureLookCoverage(pointsRoom([[1.9, 3.9, 1.9], [1.91, 3.9, 1.9]]));
  for (const id of ['v2.lightOrbs', 'v2.orbCollision', 'v2.fireworks']) {
    assert.equal(corner.eligible.has(id), false, id);
    assert.ok(corner.darkBeats.get(id) > 4, id);
  }
  const lamps = pointsRoom(Array.from({ length: 32 }, (_, i) => {
    const a = i * Math.PI / 16;
    return [Math.cos(a) * 2, 1.2 + Math.sin(a * 2) * 0.8, Math.sin(a) * 2];
  }));
  const coverage = await measureLookCoverage(lamps);
  assert.ok(coverage.eligible.has('v2.lightOrbs'));
  assert.ok(coverage.darkBeats.get('v2.lightOrbs') <= 4);
  assert.ok(availableFor(V2_PRESETS, null, { usable: coverage.eligible }).has('v2.lightOrbs'));
});

/** The runtime rig (a wall of 2,400 cells, a keyboard, two strips, thirty lamps) with every unit placed by hand. */
function placedRoom(name, at) {
  const { rig, space } = runtimeRig();
  const x = new Float32Array(space.n), y = new Float32Array(space.n), z = new Float32Array(space.n);
  rig.units.forEach(({ fixture }, u) => { [x[u], y[u], z[u]] = at(fixture, u); });
  return effectRoom(voiceLayout(rig), { ...space, revision: name, x, y, z });
}

test('fixtures count once whatever their cell count: a panel on the path does not outvote the lamps off it', async () => {
  // Light Orbs circle the listener two metres out; whatever is not on that ring hangs out of their reach.
  const ring = (u) => [Math.cos(u * 2.4) * 2, 1.2, Math.sin(u * 2.4) * 2], away = [0, 3, 0];
  const panel = await measureLookCoverage(placedRoom('panel', (fixture, u) => (fixture === 0 ? ring(u) : away)));
  assert.ok(panel.litShare.get('v2.lightOrbs') < 0.02, `one fixture of 34: ${panel.litShare.get('v2.lightOrbs')}`);
  assert.equal(panel.eligible.has('v2.lightOrbs'), false, '2,400 of 3,000 cells on the path are still one fixture');
  assert.equal(panel.darkBeats.get('v2.lightOrbs'), 0, 'it was never all dark: one lit unit used to be enough');
  const lamps = await measureLookCoverage(placedRoom('lamps', (fixture, u) => (fixture >= 4 ? ring(u) : away)));
  assert.ok(lamps.litShare.get('v2.lightOrbs') > 0.15, `thirty fixtures of 34: ${lamps.litShare.get('v2.lightOrbs')}`);
  assert.equal(lamps.eligible.has('v2.lightOrbs'), true);
});

test('every look an automatic show may pick is measured, and a rig no shape reaches keeps the looks every fixture shows', async () => {
  const corner = await measureLookCoverage(pointsRoom([[1.9, 3.9, 1.9], [1.91, 3.9, 1.9]]));
  assert.deepEqual([...corner.darkBeats.keys()].sort(), [...MEASURED_LOOKS].sort());
  assert.deepEqual([...corner.litShare.keys()].sort(), [...MEASURED_LOOKS].sort());
  assert.equal(corner.litShare.get('v2.wash'), 1);
  assert.ok(corner.eligible.has('v2.wash') && corner.eligible.has('v2.rotation'));
  assert.ok(corner.eligible.size < MEASURED_LOOKS.size);
  for (const id of corner.eligible) assert.ok(corner.litShare.get(id) >= 0.1 && corner.darkBeats.get(id) <= 4, id);
});

test('coverage yields before rendering and between samples, so timers remain runnable', async () => {
  let pauses = 0, timerRan = false;
  const pending = measureLookCoverage(pointsRoom([[2, 1.2, 0]]), () => false, async () => {
    pauses++; await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(pauses, 1);
  setImmediate(() => { timerRan = true; });
  await pending;
  assert.ok(pauses > 32);
  assert.equal(timerRan, true);
});

const measured = async (rig, space) => [...(await measureLookCoverage(effectRoom(voiceLayout(rig), space))).eligible].sort();

test('while a show wants it, the cache reuses unchanged geometry, re-measures profiles/order/room and cancels stale work', async () => {
  const { fixtures, profileOf } = syntheticRig();
  const rig = buildRig(fixtures, profileOf), space = syntheticSpace();
  const inRoom = await measured(rig, space);
  let changes = 0;
  const cache = new LookCoverage(() => changes++);
  cache.want(true);
  assert.equal(cache.forRig(rig, space).size, 0);
  assert.equal(changes, 0, 'starting a probe returns without synchronous rendering');
  const pending = cache.ready;
  cache.forRig(rig, space);
  assert.equal(cache.ready, pending);
  const moved = { ...space, revision: `${space.revision}/moved`, x: new Float32Array(space.n).fill(50) };
  cache.forRig(rig, moved);
  await cache.ready; await pending;
  assert.equal(changes, 1, 'superseded geometry cannot publish its eligible result');
  assert.deepEqual([...cache.allowed].sort(), await measured(rig, moved));
  assert.notDeepEqual([...cache.allowed].sort(), inRoom);
  const previous = cache.ready;
  cache.forRig(rig, moved);
  assert.equal(cache.ready, previous);
  const reordered = buildRig([...fixtures].reverse(), profileOf);
  cache.forRig(reordered, null);
  assert.notEqual(cache.ready, previous);
  await cache.ready;
  assert.equal(changes, 2);
  assert.deepEqual([...cache.allowed].sort(), await measured(reordered, null));
  assert.notDeepEqual([...cache.allowed].sort(), inRoom);
  const profilesChanged = buildRig(fixtures, (f) => ({ ...profileOf(f) }));
  const before = cache.ready;
  const shown = cache.forRig(profilesChanged, space);
  assert.notEqual(cache.ready, before);
  assert.equal(shown, cache.allowed, 'the last result stays out while the next is measured: no empty round trip');
  await cache.ready;
  assert.equal(changes, 3);
  assert.deepEqual([...cache.allowed].sort(), inRoom);
});

const PRESETS = V2_PRESETS.filter((p) => MEASURED_LOOKS.has(p.id)), CANDIDATES = PRESETS.length;
const KINDS = [...new Set(PRESETS.map((p) => p.spec.kind))].map((kind) => kindOf(kind));

/** Counts the probe's measurements (one init per candidate preset) and renders while `fn` runs. */
async function counting(fn) {
  const seen = { inits: 0, renders: 0 }, originals = KINDS.map(({ init, render }) => ({ init, render }));
  KINDS.forEach((def, k) => {
    def.init = (...args) => { seen.inits++; return originals[k].init(...args); };
    def.render = (...args) => { seen.renders++; return originals[k].render(...args); };
  });
  try { await fn(seen); } finally { KINDS.forEach((def, k) => Object.assign(def, originals[k])); }
  return seen;
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('with the show off a changed rig is only recorded: nothing renders and the set is empty until a show wants it', async () => {
  const { fixtures, profileOf } = syntheticRig();
  const space = syntheticSpace();
  let changes = 0;
  const cache = new LookCoverage(() => changes++);
  const seen = await counting(async () => {
    for (let i = 0; i < 3; i++) {
      const rig = buildRig(fixtures.map((f) => ({ ...f, position: { ...f.position, x: f.position.x + i } })), profileOf);
      assert.equal(cache.forRig(rig, space).size, 0);
      await cache.ready; await settle();
    }
  });
  assert.deepEqual(seen, { inits: 0, renders: 0 });
  assert.equal(changes, 0);

  const pending = buildRig(fixtures, profileOf), inRoom = await measured(pending, space);
  cache.forRig(pending, space);
  const wanted = await counting(async () => {
    cache.want(true);
    assert.equal(cache.forRig(pending, space).size, 0, 'the pending rig is being measured');
    cache.want(true);
    await cache.ready;
  });
  assert.equal(wanted.inits, CANDIDATES, 'wanting it measures the pending rig once');
  assert.equal(changes, 1);
  const published = cache.allowed;
  assert.deepEqual([...published].sort(), inRoom);

  const off = await counting(async () => {
    cache.want(false);
    assert.equal(cache.forRig(pending, space), published, 'the stored result is this rig\'s, so it stays');
    const edited = buildRig(fixtures.map((f) => ({ ...f, group: 'edited' })), profileOf);
    assert.equal(cache.forRig(edited, space), cache.allowed);
    assert.equal(cache.allowed.size, 0, 'a rig without a result of its own gets none while the show is off');
    await cache.ready; await settle();
  });
  assert.deepEqual(off, { inits: 0, renders: 0 });
  assert.equal(changes, 1);
});

test('stopping the show cancels a measurement in progress, and starting it again measures afresh', async () => {
  const { fixtures, profileOf } = syntheticRig();
  const rig = buildRig(fixtures, profileOf), space = syntheticSpace();
  let changes = 0;
  const cache = new LookCoverage(() => changes++);
  const seen = await counting(async (counts) => {
    cache.want(true);
    cache.forRig(rig, space);
    while (counts.renders < 3) await new Promise((resolve) => setImmediate(resolve));
    cache.want(false);
    const stoppedAt = counts.renders;
    await settle();
    assert.ok(counts.renders <= stoppedAt + 1, 'the cancelled probe stops within a sample');
    assert.equal(changes, 0);
    assert.equal(cache.forRig(rig, space).size, 0);
    cache.want(true);
    await cache.ready;
  });
  assert.equal(seen.inits, CANDIDATES + 1, 'the first probe stopped in its first preset; the second ran whole');
  assert.equal(changes, 1);
  assert.deepEqual([...cache.allowed].sort(), await measured(rig, space));
});

test('a measurement with the same result keeps the published set, so nothing re-plans', async () => {
  const { fixtures, profileOf } = syntheticRig();
  const space = syntheticSpace();
  let changes = 0;
  const cache = new LookCoverage(() => changes++);
  cache.want(true);
  cache.forRig(buildRig(fixtures, profileOf), space);
  await cache.ready;
  const published = cache.allowed;
  assert.equal(changes, 1);
  // Same geometry, new objects: what a profile re-registration or a show reload hands over.
  const again = buildRig(fixtures, (f) => ({ ...profileOf(f) }));
  const seen = await counting(async () => {
    assert.equal(cache.forRig(again, space), published);
    await cache.ready;
  });
  assert.equal(seen.inits, CANDIDATES, 'it was measured');
  assert.equal(cache.allowed, published, 'identical contents keep the identity');
  assert.equal(cache.forRig(again, space), published);
  assert.equal(changes, 1, 'and nobody is told');
});

// While a show runs, the last set stays out until the next one is measured. A measurement that fails
// leaves no next one: the set out then is another rig's, so the show is back on the unmeasured set.
test('a measurement that fails while a show runs takes the previous rig\'s result away', async (t) => {
  const { fixtures, profileOf } = syntheticRig();
  const space = syntheticSpace();
  let changes = 0;
  const cache = new LookCoverage(() => changes++);
  cache.want(true);
  cache.forRig(buildRig(fixtures, profileOf), space);
  await cache.ready;
  assert.ok(cache.allowed.size > 0);
  assert.equal(changes, 1);
  const warn = t.mock.method(console, 'warn', () => {});
  const render = t.mock.method(kindOf('v2.particles'), 'render', () => { throw new Error('no room for it'); });
  const moved = buildRig(fixtures.map((f) => ({ ...f, group: 'moved' })), profileOf);
  try {
    cache.forRig(moved, space);
    await cache.ready;
  } finally { render.mock.restore(); }
  assert.equal(warn.mock.callCount(), 1, 'the failure is reported');
  assert.equal(cache.allowed.size, 0, 'no result for a rig nobody could measure');
  assert.equal(changes, 2, 'and the show is told');
  assert.equal(cache.forRig(moved, space).size, 0);
});

/** The probe's slot output over every sample, hashed, with the frame's gaps revealed as the probe did before, or not. */
async function probeOutput(room, reveal) {
  const def = kindOf('v2.particles'), render = def.render;
  const hash = createHash('sha256');
  let values = new Float64Array(0);
  def.render = (params, state, r, frame, out) => {
    if (reveal) delete frame.revealGaps;
    else assert.strictEqual(frame.revealGaps, false, 'the probe frame does not reveal gaps');
    const result = render(params, state, r, frame, out);
    if (values.length !== out.length * 8) values = new Float64Array(out.length * 8);
    out.forEach((slot, i) => {
      const c = slot.colour;
      values.set([slot.level, slot.strength, c.r, c.g, c.b, c.w ?? 0, c.a ?? 0, c.uv ?? 0], i * 8);
    });
    hash.update(new Uint8Array(values.buffer));
    return result;
  };
  try {
    const { eligible, darkBeats } = await measureLookCoverage(room);
    return { eligible: [...eligible], darkBeats: [...darkBeats], output: hash.digest('hex') };
  } finally { def.render = render; }
}

test('a probe that does not reveal gaps measures the same levels, colours, eligibility and dark beats', async () => {
  const synthetic = syntheticRig();
  const runtime = runtimeRig();
  for (const [name, room] of [
    ['synthetic', effectRoom(voiceLayout(buildRig(synthetic.fixtures, synthetic.profileOf)), syntheticSpace())],
    ['runtime', effectRoom(voiceLayout(runtime.rig), runtime.space)],
  ]) {
    const revealed = await probeOutput(room, true);
    const unrevealed = await probeOutput(room, false);
    assert.deepStrictEqual(unrevealed, revealed, name);
    assert.ok(revealed.eligible.length > 0 && revealed.darkBeats.length === CANDIDATES, name);
  }
});


test('the probe renders only one frame between yields and cancellation stops before the next frame', async () => {
  const def = KINDS[0], render = def.render;
  let renders = 0, cancelled = false;
  const resumes = [];
  def.render = (...args) => { renders++; return render(...args); };
  try {
    const pending = measureLookCoverage(pointsRoom([[2, 1.2, 0]]), () => cancelled,
      () => new Promise((resolve) => resumes.push(resolve)));
    assert.equal(renders, 0);
    resumes.shift()();
    await Promise.resolve();
    assert.equal(renders, 1);
    assert.equal(resumes.length, 1);
    cancelled = true;
    resumes.shift()();
    const result = await pending;
    assert.equal(renders, 1);
    assert.equal(result.eligible.size, 0);
    assert.equal(result.darkBeats.size, 0);
  } finally { def.render = render; }
});
