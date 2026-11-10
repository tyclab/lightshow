// The engine's worker thread renders exactly what the main thread would, and
// keeps rendering when the main thread cannot.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { state } from '../../src/server/state.ts';
import * as universes from '../../src/server/universes.ts';
import { baseIntentOf, createRenderer } from '../../src/server/renderer.ts';
import { startEngine, stopEngine, engineStatus, effectCommand, setEffectSource } from '../../src/server/engine.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { hrtimeMs } from '../../src/server/frame-clock.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { getProfile, profilesRevision, registerProfile, unregisterProfile } from '../../src/server/profiles.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { FRAME_MS } from '../../src/server/frame-clock.ts';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';

const WORKER = path.join(import.meta.dirname, '..', '..', 'src', 'server', 'engine-worker.ts');

/** The same seeded stand-in for Math.random the worker uses in capture mode. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A worker in capture mode: renders one frame per request and sends the bytes back. */
async function captureWorker({ seed, startNow }) {
  const w = new Worker(WORKER, { workerData: { shared: universes.allocateShared(), capture: true, seed, startNow } });
  const pending = new Map();
  let id = 0;
  const decided = [];
  await new Promise((resolve, reject) => {
    w.on('message', (m) => {
      if (m.type === 'ready') resolve();
      if (m.type === 'rendered') { decided.push(...(m.commands ?? [])); pending.get(m.id)(m.frames); pending.delete(m.id); }
    });
    w.once('error', reject);
  });
  return {
    profiles: (profiles) => w.postMessage({ type: 'profiles', profiles }),
    points: (points) => w.postMessage({ type: 'points', points }),
    render: (input, reading, now, gridOriginMs) => new Promise((resolve) => {
      const k = ++id;
      pending.set(k, resolve);
      w.postMessage({ type: 'render', id: k, input, reading, now, ...(gridOriginMs === undefined ? {} : { gridOriginMs }) });
    }),
    command: (seq, cmd, arg, intent) => w.postMessage({ type: 'command', seq, cmd, arg, intent }),
    /** The commands the worker has decided so far, as its replies carried them. */
    decided,
    close: () => w.terminate(),
  };
}

/** The same renderer on this thread, on its own store and its own dice. */
function localRenderer({ seed, startNow }) {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: startNow });
  const dice = seeded(seed);
  const render = (input, reading, now, gridOriginMs) => {
    const realRandom = Math.random;
    Math.random = dice;
    try {
      renderer.frame(input, reading, now, store, gridOriginMs);
    } finally {
      Math.random = realRandom;
    }
    const frames = {};
    for (const universe of store.list()) frames[universe] = Array.from(store.getBuffer(universe));
    for (const [universe] of store.drainRetired()) frames[universe] = null;
    return frames;
  };
  render.renderer = renderer;
  return render;
}

const BAR = barProfile({ id: 'worker-test-bar', name: 'Test Bar', cells: 8, firstChannel: 3, order: 'RGBW', dimmer: 1, strobe: 2 });

const fixture = (id, address, extra = {}) => ({
  id, address, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255,
  override: null, position: null, group: null, geometry: null, ...extra,
});

const RIGS = {
  pars: [
    fixture(0, 1, { position: { x: 80, y: 20 }, group: 'front' }),
    fixture(1, 13, { position: { x: 10, y: 60 }, group: 'back' }),
    fixture(2, 25, { maxBrightness: 120 }),
    fixture(3, 37),
    fixture(4, 49, { profileId: 'generic-hue-lamp-7ch' }),
    fixture(5, 56, { profileId: 'generic-hue-white-ambiance-3ch' }),
  ],
  bars: [
    fixture(0, 1, { profileId: BAR.id, position: { x: 30, y: 30 }, geometry: { length: 20, angle: 0 } }),
    fixture(1, 40, { profileId: BAR.id, position: { x: 70, y: 30 }, geometry: { length: 20, angle: 90 } }),
    fixture(2, 80),
    fixture(3, 1, { universe: 1 }),
  ],
};

const DYNAMICS = { level: 0.7, bass: 0.8, vocal: 0.3, air: 0.5, width: 0.6, motion: 0.5, decay: 0.2 };

/** A run of scenes as (input, reading, now) triples, the same for both threads. */
function scenes(fixtures) {
  const out = [];
  let beat = 0;
  let now = 1000;
  let anchorSeq = 0;
  const base = {
    running: true, colorA: 1, colorB: 5, colorC: 3, colorD: 8, split: null, pixelMap: 'stage',
    beatDivision: 2, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
    energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null,
    universes: [...new Set([0, ...fixtures.map((f) => f.universe)])].sort((a, b) => a - b),
    fixtures,
  };
  const run = (patch, frames = 16) => {
    const input = { ...base, ...patch, patternAnchor: { step: 0, epoch: 0, seq: ++anchorSeq } };
    for (let f = 0; f < frames; f++) {
      out.push([input, { beatPos: beat, bpm: 120, source: 'tap', epoch: 0 }, now]);
      beat += 0.125;
      now += FRAME_MS;
    }
  };
  const patterns = ['solid', 'fade', 'hit', 'chase', 'wave', 'rainbow', 'twinkle', 'sparkle', 'random-flash',
    'ensemble', 'ribbon', 'sections', 'gradient', 'comet', 'burst', 'plasma', 'meter', 'strobe'];
  for (const pattern of patterns) run({ pattern, strobeSpeed: pattern === 'strobe' ? 200 : 0 });
  for (const strobeFunction of ['ramp-up', 'random', 'break']) {
    run({ pattern: 'strobe', strobeSpeed: 255, strobeFunction, hardware: { technologies: {}, products: {} },
      fixtures: fixtures.map((f) => ({ ...f, hardware: { maxFlashHz: 1, minTransitionMs: 0 } })) }, 60);
    run({ pattern: 'strobe', strobeSpeed: 255, strobeFunction, masterBlackout: true }, 2);
  }
  for (const pattern of ['wave', 'twinkle', 'ribbon']) run({ pattern, showDynamics: DYNAMICS });
  for (const pixelMap of ['bar', 'mirror']) run({ pattern: 'comet', pixelMap });
  // The pars and the bars on a look each, random dice on both sides included.
  run({ pattern: 'hit', pixelPattern: 'impact' });
  run({ pattern: 'sections', pixelPattern: 'rise', pixelSpan: 16, pixelFrom: 0.25, pixelMap: 'mirror' });
  run({ pattern: 'twinkle', pixelPattern: 'sparkle' });
  run({ pattern: 'chase', split: 0 });
  run({ pattern: 'chase', energy: 'color-strobe' }, 8);
  run({ pattern: 'wave', fade: { seq: 1, ms: 300, at: now }, colorA: 5 });
  run({ pattern: 'solid', fixtures: fixtures.map((f, i) => (i === 1 ? { ...f, override: { enabled: true, r: 200, g: 10, b: 30, w: 0, dim: 180 } } : f)) }, 4);
  run({ pattern: 'solid', masterBlackout: true }, 2);
  run({ pattern: 'solid', masterDimmer: 90, fixtures: fixtures.slice(0, 1), universes: [0] }, 4);
  return out;
}

for (const [name, fixtures] of Object.entries(RIGS)) {
  test(`the worker renders a rig of ${name} byte for byte as the main thread does`, async () => {
    registerProfile(BAR);
    const seed = 99;
    const startNow = 0;
    const worker = await captureWorker({ seed, startNow });
    try {
      worker.profiles([BAR]);
      const local = localRenderer({ seed, startNow });
      let frame = 0;
      for (const [input, reading, now] of scenes(fixtures)) {
        const expected = local(input, reading, now);
        const got = await worker.render(input, reading, now);
        assert.deepStrictEqual(got, expected, `frame ${frame} (${input.pattern}) differs`);
        frame++;
      }
      assert.ok(frame > 300);
    } finally {
      await worker.close();
      unregisterProfile(BAR.id);
    }
  });
}

// ── Effects, on both threads ─────────────────────────────────────────────────

/** A run of frames of one effect look, with voices over it, as (input, reading, now) triples from `now`. */
function effectScenes(fixtures, { pattern, effect, voices, frames = 120, now = 1000, extra = {} }) {
  const out = [];
  for (let f = 0; f < frames; f++) {
    const input = {
      running: true, pattern, effect, colorA: 1, colorB: 5, colorC: 3, colorD: 8, split: null, pixelMap: 'stage',
      beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
      energy: null, showDynamics: null, patternAnchor: { step: 0, epoch: 0, seq: 1 }, fade: null, syncTest: null,
      universes: [...new Set([0, ...fixtures.map((x) => x.universe)])].sort((a, b) => a - b), fixtures,
      safety: { hdFlashIntervalMs: 350, acknowledged: true }, hueStrobe: 'pulse', ...(voices ? { voices } : {}), ...extra,
    };
    out.push([input, { beatPos: f * FRAME_MS / 500, bpm: 120, source: 'tap', epoch: 0 }, now + f * FRAME_MS]);
  }
  return out;
}

test('a preset renders the same bytes on the worker as on the main thread', async () => {
  registerProfile(BAR);
  const seed = 5;
  const worker = await captureWorker({ seed, startNow: 0 });
  try {
    worker.profiles([BAR]);
    const local = localRenderer({ seed, startNow: 0 });
    const fadeCycle = presetById('ldj.FadeCycle').spec;
    const runs = [
      // The base effect as its spec rides in the snapshot.
      { pattern: 'ldj.FadeCycle', effect: fadeCycle },
      { pattern: 'solid', voices: [{ id: 'drawn-strobe', spec: validateSpec({ kind: 'strobe', params: { function: 'random', speed: 255 } }),
        targets: null, tier: 'strobe', launchSeq: 1, startedAtMs: 1000, untilMs: null, anchorBeat: 0, seed: seedFrom('drawn-strobe') }],
        extra: { hardware: { technologies: {}, products: {} } } },
      // A stateful random kind, with voices on chosen fixtures over it.
      { pattern: 'ldj.ScatterStrobe', effect: presetById('ldj.ScatterStrobe').spec, voices: [
        { id: 'pad:1', spec: presetById('hd.neonPulse').spec, targets: [0, 4], tier: 'voice', launchSeq: 1, startedAtMs: 1200, untilMs: 2500, anchorBeat: 0, seed: seedFrom('pad:1') },
        { id: 'strobe', spec: presetById('palette-strobe').spec, targets: null, tier: 'strobe', launchSeq: 2, startedAtMs: 1800, untilMs: null, anchorBeat: 0, seed: seedFrom('strobe') },
      ] },
    ];
    for (const fixtures of [RIGS.pars, RIGS.bars]) {
      for (const run of runs) {
        let frame = 0;
        for (const [input, reading, now] of effectScenes(fixtures, run)) {
          const grid = 1000 + 7.3;
          assert.deepStrictEqual(await worker.render(input, reading, now, grid), local(input, reading, now, grid), `${run.pattern} frame ${frame}`);
          frame++;
        }
      }
    }
  } finally {
    await worker.close();
    unregisterProfile(BAR.id);
  }
});

test('commands decide alike on both threads: the same results, then the same bytes', async () => {
  const seed = 11;
  const worker = await captureWorker({ seed, startNow: 0 });
  try {
    const local = localRenderer({ seed, startNow: 0 });
    // Studio Fireworks starts notes by itself; a stop ends that, a toggle and a duplicate land once.
    const studio = validateSpec({ kind: 'ldj.StudioFireworks', palette: ['#FF0000', '#00FF00'] });
    const intent = baseIntentOf({ pattern: 'studio', effect: studio });
    const scenes = effectScenes(RIGS.pars, { pattern: 'studio', effect: studio, frames: 90 });
    const plan = { 10: [[1, 'toggleDirection'], [2, 'toggleDirection'], [2, 'toggleDirection']], 30: [[3, 'setPulserBaselineColor', { r: 0, g: 0, b: 255 }]],
      50: [[4, 'stop'], [5, 'explode']] };
    const localDecided = [];
    for (let f = 0; f < scenes.length; f++) {
      for (const [seq, cmd, arg] of plan[f] ?? []) {
        worker.command(seq, cmd, arg, intent);
        local.renderer.command(seq, cmd, arg, intent);
      }
      const [input, reading, now] = scenes[f];
      assert.deepStrictEqual(await worker.render(input, reading, now, 1000), local(input, reading, now, 1000), `frame ${f}`);
      localDecided.push(...local.renderer.takeCommandResults());
    }
    assert.deepStrictEqual(worker.decided, localDecided);
    assert.deepStrictEqual(localDecided, [
      { seq: 1, status: 'applied' }, { seq: 2, status: 'applied' }, { seq: 2, status: 'duplicate' },
      { seq: 3, status: 'applied' }, { seq: 4, status: 'applied' }, { seq: 5, status: 'invalid' },
    ]);
  } finally {
    await worker.close();
  }
});

// A stand-in engine worker that answers a command late, after the engine has
// let it go, and counts in its stats what reached it: a retired worker's word
// must not count, and nothing may be sent on to the next one.
const FAKE_WORKER = `
import { parentPort } from 'node:worker_threads';
let commands = 0;
const stats = () => parentPort.postMessage({ type: 'stats', stats: { frames: commands, lateMs: { p50: 0, p95: 0, max: 0 }, renderMs: { p50: 0, p95: 0, max: 0 }, lateFrames: 0, skippedFramesTotal: 0 } });
parentPort.on('message', (msg) => {
  if (msg.type === 'command') {
    commands++;
    stats();
    if (process.env.FAKE_WORKER_CRASH) process.exit(1);
    setTimeout(() => parentPort.postMessage({ type: 'commands', results: [{ seq: msg.seq, status: 'applied' }], processed: msg.seq, applied: msg.seq }), 100);
  }
  if (msg.type === 'stop') setTimeout(() => parentPort.postMessage({ type: 'stopped' }), 200);
});
parentPort.postMessage({ type: 'ready' });
stats();
`;

test('failed driver commands reject late answers without replay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-fake-worker-'));
  const file = path.join(dir, 'fake-worker.mjs');
  fs.writeFileSync(file, FAKE_WORKER);
  state.artnet.enabled = false;
  const studio = { kind: 'ldj.StudioSwirl', params: {} };
  setEffectSource((pattern) => (pattern === 'studio' ? studio : null));
  applyPatch({ pattern: 'studio', running: true, masterDimmer: 255, masterBlackout: false });
  try {
    startEngine({ thread: 'worker', file });
    const before = engineStatus().commands;
    const pending = effectCommand('toggleDirection');
    // The engine stops while the worker sits on the command; its answer comes 100 ms later.
    await new Promise((r) => setTimeout(r, 20));
    const stopped = stopEngine();
    assert.deepStrictEqual(await pending, { seq: before.submitted + 1, status: 'unavailable' }, 'ambiguous: neither applied nor refused there');
    await stopped;
    await new Promise((r) => setTimeout(r, 150));
    assert.deepStrictEqual(engineStatus().commands, { submitted: before.submitted + 1, processed: before.processed, applied: before.applied },
      'the retired worker\'s late "applied" is no acknowledgement');
    // A worker that dies with the command: the engine starts another, which never hears of it.
    process.env.FAKE_WORKER_CRASH = '1';
    startEngine({ thread: 'worker', file });
    const lost = await effectCommand('toggleDirection');
    assert.strictEqual(lost.status, 'unavailable');
    delete process.env.FAKE_WORKER_CRASH;
    const until = Date.now() + 3000;
    while (!(engineStatus().thread === 'worker' && engineStatus().frames === 0) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(engineStatus().frames, 0, 'the new worker was sent no command');
  } finally {
    delete process.env.FAKE_WORKER_CRASH;
    await stopEngine();
    setEffectSource(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Mapped points, held by the engine thread ────────────────────────────────

const MAPPED = barProfile({ id: 'worker-mapped-bar', name: 'Mapped bar', cells: 24, firstChannel: 1, order: 'RGB' });

/** The pars beside a bar mapped point by point, as a curtain is; `shift` moves the points. */
function mappedRig(shift = 0) {
  return [...RIGS.pars, fixture(6, 1, { universe: 1, profileId: MAPPED.id, position: { x: 50, y: 30, height: 40 },
    geometry: { length: 30, angle: 0, points: Array.from({ length: 24 }, (_, i) => ({
      x: ((i * 5 + shift) % 24) - 12, y: Math.floor(i / 6) * 3, height: (i * 7 + shift * 3) % 60 })) } })];
}

/** The input as the engine now posts it: every fixture's geometry without its points. */
const withoutPoints = (input) => ({ ...input, fixtures: input.fixtures.map((f) => {
  if (!f.geometry?.points) return f;
  const { points: _points, ...geometry } = f.geometry;
  return { ...f, geometry };
}) });

test('a seeded run renders the same bytes with the points held by the worker as with the points in every input', async () => {
  registerProfile(MAPPED);
  const seed = 23;
  const before = await captureWorker({ seed, startNow: 0 });
  const after = await captureWorker({ seed, startNow: 0 });
  try {
    for (const w of [before, after]) w.profiles([MAPPED]);
    const runs = [
      ...effectScenes(mappedRig(), { pattern: 'wave', frames: 40 }),
      ...effectScenes(mappedRig(), { pattern: 'rainbow', frames: 40, now: 3000 }),
      ...effectScenes(mappedRig(), { pattern: 'v2.lightOrbs', effect: presetById('v2.lightOrbs').spec, frames: 60, now: 5000 }),
    ];
    after.points(runs[0][0].fixtures.map((f) => f.geometry?.points ?? null));
    let frame = 0;
    for (const [input, reading, now] of runs) {
      const posted = withoutPoints(input);
      assert.ok(posted.fixtures.every((f) => !f.geometry?.points), 'nothing cloned carries a point');
      assert.deepStrictEqual(await after.render(posted, reading, now), await before.render(input, reading, now), `frame ${frame}`);
      frame++;
    }

    // Edited part way through a run: the next frame draws the new points.
    const scenes = effectScenes(mappedRig(), { pattern: 'wave', frames: 20, now: 9000 });
    const edited = mappedRig(7);
    for (let f = 0; f < scenes.length; f++) {
      const [input, reading, now] = scenes[f];
      if (f === 10) after.points(edited.map((x) => x.geometry?.points ?? null));
      const full = f < 10 ? input : { ...input, fixtures: edited };
      const got = await after.render(withoutPoints(full), reading, now);
      assert.deepStrictEqual(got, await before.render(full, reading, now), `frame ${f}`);
      if (f === 10) {
        const stale = localRenderer({ seed, startNow: 0 });
        assert.notDeepStrictEqual(got[1], stale(input, reading, now)[1], 'the edit shows in the bar\'s universe');
      }
    }
  } finally {
    await before.close();
    await after.close();
    unregisterProfile(MAPPED.id);
  }
});

// A capture render, or a snapshot from a driver that never strips them, brings each fixture's own points.
// The points the worker holds are the live patch's: they must not replace what an input brings.
test('a fixture that brings its own points keeps them over the ones the worker holds', async () => {
  registerProfile(MAPPED);
  const seed = 29;
  const reference = await captureWorker({ seed, startNow: 0 });
  const holding = await captureWorker({ seed, startNow: 0 });
  try {
    for (const w of [reference, holding]) w.profiles([MAPPED]);
    holding.points(mappedRig().map((f) => f.geometry?.points ?? null));
    const own = effectScenes(mappedRig(7), { pattern: 'wave', frames: 12, now: 2000 });
    const held = effectScenes(mappedRig(), { pattern: 'wave', frames: 12, now: 2000 });
    const stale = localRenderer({ seed, startNow: 0 });
    let differs = false;
    for (let f = 0; f < own.length; f++) {
      const [input, reading, now] = own[f];
      const got = await holding.render(input, reading, now);
      assert.deepStrictEqual(got, await reference.render(input, reading, now), `frame ${f}`);
      differs ||= JSON.stringify(got[1]) !== JSON.stringify(stale(...held[f])[1]);
    }
    assert.ok(differs, 'the held points would have drawn something else');
  } finally {
    await reference.close();
    await holding.close();
    unregisterProfile(MAPPED.id);
  }
});

/** A worker that records what the engine posts it: message types, and whether a snapshot carried any point. */
const POINTS_WORKER = `
import { parentPort } from 'node:worker_threads';
const log = [{ type: 'start', crash: !!process.env.POINTS_WORKER_CRASH }];
parentPort.on('message', (msg) => {
  if (msg.type === 'points') log.push({ type: 'points', counts: msg.points.map((p) => p?.length ?? 0), first: msg.points.find(Boolean)?.[0] ?? null });
  if (msg.type === 'snapshot') {
    log.push({ type: 'snapshot', points: msg.input.fixtures.some((f) => f.geometry && 'points' in f.geometry),
      ids: msg.input.fixtures.map((f) => f.id), trims: msg.input.fixtures.map((f) => f.maxBrightness) });
    if (process.env.POINTS_WORKER_CRASH && log.filter((e) => e.type === 'snapshot').length >= 3) process.exit(1);
    parentPort.postMessage({ type: 'frame', barrierRevision: msg.barrierRevision });
  }
  if (msg.type === 'stop') parentPort.postMessage({ type: 'stopped', applied: true });
  parentPort.postMessage({ type: 'stats', stats: { log } });
});
parentPort.postMessage({ type: 'ready' });
`;

test('the engine posts a fixture\'s points once and again only when they change; its snapshots carry none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-points-worker-'));
  const file = path.join(dir, 'points-worker.mjs');
  fs.writeFileSync(file, POINTS_WORKER);
  registerProfile(MAPPED);
  const before = { fixtures: state.fixtures, artnet: state.artnet.enabled };
  state.artnet.enabled = false;
  state.fixtures = mappedRig().map((f) => structuredClone(f));
  const log = () => engineStatus().log ?? [];
  const points = () => log().filter((e) => e.type === 'points');
  const snapshots = () => log().filter((e) => e.type === 'snapshot');
  try {
    startEngine({ thread: 'worker', file });
    await until(() => snapshots().length >= 20, 'twenty snapshots');
    assert.strictEqual(points().length, 1, 'the points once, however many snapshots');
    assert.deepStrictEqual(points()[0].counts, [0, 0, 0, 0, 0, 0, 24]);
    assert.ok(snapshots().every((e) => !e.points), 'no snapshot carries a point');

    const mapped = state.fixtures[6];
    mapped.geometry.points[0].x = 11;
    await until(() => points().length === 2, 'the edited points');
    assert.strictEqual(points()[1].first.x, 11, 'an edit in place is seen');
    const seen = snapshots().length;
    await until(() => snapshots().length >= seen + 10, 'ten more snapshots');
    assert.strictEqual(points().length, 2, 'and nothing more while they stand still');

    mapped.label = 'Renamed';
    mapped.geometry = structuredClone(mapped.geometry);
    const quiet = snapshots().length;
    await until(() => snapshots().length >= quiet + 10, 'ten more snapshots');
    assert.strictEqual(points().length, 2, 'equal points in new objects are no change');

    delete mapped.geometry.points;
    await until(() => points().length === 3, 'the points gone');
    assert.deepStrictEqual(points()[2].counts, [0, 0, 0, 0, 0, 0, 0]);
  } finally {
    await stopEngine();
    state.fixtures = before.fixtures;
    state.artnet.enabled = before.artnet;
    unregisterProfile(MAPPED.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The worker puts the held points back by each fixture's place in the snapshot: a snapshot rendered
// before the points of its own patch arrive draws the previous patch's points, or puts them on the wrong fixture.
test('every snapshot follows the points of its own patch: after an edit, a removal and a new order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-points-order-'));
  const file = path.join(dir, 'points-worker.mjs');
  fs.writeFileSync(file, POINTS_WORKER);
  registerProfile(MAPPED);
  const before = { fixtures: state.fixtures, artnet: state.artnet.enabled };
  state.artnet.enabled = false;
  state.fixtures = mappedRig().map((f) => structuredClone(f));
  const mappedId = state.fixtures.at(-1).id;
  const log = () => engineStatus().log ?? [];
  const snapshots = () => log().filter((e) => e.type === 'snapshot');
  // Each snapshot against the last points message before it: the mapped fixture's place, and its first point.
  const consistent = (what) => {
    let held = null;
    for (const e of log()) {
      if (e.type === 'points') held = e;
      if (e.type !== 'snapshot') continue;
      assert.ok(held, `${what}: points before the first snapshot`);
      assert.deepStrictEqual(held.counts, e.ids.map((id) => (id === mappedId ? 24 : 0)), `${what}: snapshot of ${e.ids}`);
      const at = e.ids.indexOf(mappedId);
      if (e.trims[at] === 77) assert.strictEqual(held.first.x, 11, `${what}: the edited trim came with the edited point`);
    }
  };
  const more = async (what) => { const seen = snapshots().length; await until(() => snapshots().length >= seen + 5, what); };
  try {
    startEngine({ thread: 'worker', file });
    await until(() => snapshots().length >= 5, 'five snapshots');
    consistent('started');

    const mapped = state.fixtures.at(-1);
    mapped.geometry.points[0].x = 11;
    mapped.maxBrightness = 77;
    await more('the edit');
    consistent('a point and a trim edited together');

    state.fixtures.splice(0, 2);
    await more('the removal');
    consistent('two fixtures before it removed');

    state.fixtures = [mapped, ...state.fixtures.filter((f) => f !== mapped).reverse()];
    await more('the new order');
    consistent('the mapped fixture first');
    assert.strictEqual(snapshots().at(-1).ids[0], mappedId);
  } finally {
    await stopEngine();
    state.fixtures = before.fixtures;
    state.artnet.enabled = before.artnet;
    unregisterProfile(MAPPED.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A replacement engine thread holds no points, though the patch has not changed since the last one got them.
test('an engine thread restarted after a crash gets the points before its first snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-points-restart-'));
  const file = path.join(dir, 'points-worker.mjs');
  fs.writeFileSync(file, POINTS_WORKER);
  registerProfile(MAPPED);
  const before = { fixtures: state.fixtures, artnet: state.artnet.enabled };
  state.artnet.enabled = false;
  state.fixtures = mappedRig().map((f) => structuredClone(f));
  const log = () => engineStatus().log ?? [];
  const snapshots = () => log().filter((e) => e.type === 'snapshot').length;
  const warn = console.warn;
  console.warn = () => {};
  try {
    process.env.POINTS_WORKER_CRASH = '1';
    startEngine({ thread: 'worker', file });
    await until(() => log()[0]?.crash === true && snapshots() >= 2, 'the first thread');
    // It dies at its third snapshot; its replacement starts a quarter of a second later and lives.
    delete process.env.POINTS_WORKER_CRASH;
    await until(() => log()[0]?.crash === false && snapshots() >= 3, 'its replacement');
    assert.strictEqual(engineStatus().thread, 'worker');
    const points = log().findIndex((e) => e.type === 'points');
    assert.ok(points >= 0 && points < log().findIndex((e) => e.type === 'snapshot'), 'the points before the first snapshot');
    assert.deepStrictEqual(log()[points].counts, [0, 0, 0, 0, 0, 0, 24]);
  } finally {
    delete process.env.POINTS_WORKER_CRASH;
    await stopEngine();
    console.warn = warn;
    state.fixtures = before.fixtures;
    state.artnet.enabled = before.artnet;
    unregisterProfile(MAPPED.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The server's engine, on its thread ───────────────────────────────────────

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lit = () => Array.from(universes.getBuffer(state.artnet.universe)).some((v) => v > 0);

test('stopped main-thread commands cannot run later', async () => {
  state.artnet.enabled = false;
  const restore = acknowledgeFlashes();
  const studio = { kind: 'ldj.StudioSwirl', params: {} };
  setEffectSource((pattern) => (pattern === 'studio' ? studio : null));
  applyPatch({ pattern: 'studio', running: true, masterDimmer: 255, masterBlackout: false });
  try {
    startEngine({ thread: 'main' });
    await wait(100);
    const before = engineStatus().commands;
    // Sent and stopped before the next frame: the stop decides it, no frame does.
    const pending = effectCommand('toggleDirection');
    const stopped = stopEngine();
    assert.deepStrictEqual(await pending, { seq: before.submitted + 1, status: 'unavailable' });
    await stopped;
    // The next driver on this thread starts its effects afresh, and the command stays undone.
    startEngine({ thread: 'main' });
    await wait(150);
    assert.strictEqual(engineStatus().commands.applied, before.applied, 'a command reported unavailable is never applied afterwards');
    // A command sent now is the new driver's, and lands.
    assert.deepStrictEqual(await effectCommand('toggleDirection'), { seq: before.submitted + 2, status: 'applied' });
  } finally {
    await stopEngine();
    setEffectSource(null);
    restore();
  }
});

test('with a worker, frames land in memory the main thread reads', async () => {
  state.artnet.enabled = false;
  applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, masterBlackout: false, colorA: 1 });
  startEngine({ thread: 'worker' });
  try {
    // The worker compiles its modules before its first frame: seconds on a slow runner.
    const until = Date.now() + 5000;
    while (!lit() && Date.now() < until) await wait(20);
    assert.strictEqual(engineStatus().thread, 'worker');
    assert.ok(lit(), 'the rendered look is visible from the main thread');
  } finally {
    await stopEngine();
  }
  assert.ok(!lit(), 'stopping blacks the rig out');
  assert.strictEqual(engineStatus().thread, null);
});

// The engine thread's isolate allocates per frame where process.memoryUsage() on this thread cannot see it.
test('the engine thread reports its own heap with its timings, and nothing once it is gone', async () => {
  state.artnet.enabled = false;
  startEngine({ thread: 'worker' });
  try {
    const until = Date.now() + 5000;
    while (!engineStatus().heap && Date.now() < until) await wait(20);
    const { thread, heap } = engineStatus();
    assert.strictEqual(thread, 'worker');
    assert.ok(Number.isInteger(heap?.usedBytes) && heap.usedBytes > 0, `used ${heap?.usedBytes}`);
    assert.ok(Number.isInteger(heap.totalBytes) && heap.totalBytes >= heap.usedBytes, `total ${heap.totalBytes}`);
  } finally {
    await stopEngine();
  }
  assert.strictEqual(engineStatus().heap, null);
  startEngine({ thread: 'main' });
  try {
    assert.strictEqual(engineStatus().heap, null, 'on the main thread, the main heap is the engine\'s');
  } finally {
    await stopEngine();
  }
});

// A stand-in engine thread that reports a heap once, when HEAP_WORKER says so, and dies after it
// when HEAP_WORKER_EXIT does; otherwise it never reports.
const HEAP_WORKER = `
import { parentPort } from 'node:worker_threads';
const timing = { frames: 1, lateMs: { p50: 0, p95: 0, max: 0 }, renderMs: { p50: 0, p95: 0, max: 0 }, lateFrames: 0, skippedFramesTotal: 0 };
parentPort.on('message', (msg) => { if (msg.type === 'stop') parentPort.postMessage({ type: 'stopped', applied: true }); });
parentPort.postMessage({ type: 'ready' });
if (process.env.HEAP_WORKER === 'report') {
  parentPort.postMessage({ type: 'stats', stats: timing, heap: { usedBytes: 1000, totalBytes: 2000 } });
  if (process.env.HEAP_WORKER_EXIT) setTimeout(() => process.exit(1), 50);
}
`;

// The summary attributes memory by these numbers: an isolate that is gone must not stand in for the one running.
test('a restarted or replaced engine thread has no heap until it reports one itself', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-heap-worker-'));
  const file = path.join(dir, 'heap-worker.mjs');
  fs.writeFileSync(file, HEAP_WORKER);
  state.artnet.enabled = false;
  const warn = console.warn;
  console.warn = () => {};
  try {
    process.env.HEAP_WORKER = 'report';
    process.env.HEAP_WORKER_EXIT = '1';
    startEngine({ thread: 'worker', file });
    let end = Date.now() + 5000;
    while (!engineStatus().heap && Date.now() < end) await wait(5);
    assert.deepStrictEqual(engineStatus().heap, { usedBytes: 1000, totalBytes: 2000 });
    // The thread dies 50 ms after its report and the engine starts another, which stays silent.
    process.env.HEAP_WORKER = 'silent';
    delete process.env.HEAP_WORKER_EXIT;
    await wait(700);
    assert.strictEqual(engineStatus().thread, 'worker', 'restarted, not fallen back');
    assert.strictEqual(engineStatus().heap, null, 'the dead thread\'s heap is not the running one\'s');
    await stopEngine();

    process.env.HEAP_WORKER = 'report';
    startEngine({ thread: 'worker', file });
    end = Date.now() + 5000;
    while (!engineStatus().heap && Date.now() < end) await wait(5);
    assert.ok(engineStatus().heap);
    await stopEngine();
    process.env.HEAP_WORKER = 'silent';
    startEngine({ thread: 'worker', file });
    await wait(300);
    assert.strictEqual(engineStatus().thread, 'worker');
    assert.strictEqual(engineStatus().heap, null, 'a new thread before its first report');
  } finally {
    delete process.env.HEAP_WORKER;
    delete process.env.HEAP_WORKER_EXIT;
    await stopEngine();
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the main thread never reads a frame the worker is part way through', async () => {
  // The DMX monitor reads the shared buffers from this thread at any moment.
  // A static look renders the same bytes every frame, so every read must match.
  const bar = barProfile({ id: 'worker-tear-bar', name: 'Tear Bar', cells: 16, firstChannel: 3, order: 'RGBW', dimmer: 1, strobe: 2 });
  registerProfile(bar);
  const before = { fixtures: state.fixtures, artnet: state.artnet.enabled };
  const perUniverse = Math.floor(512 / bar.channelCount);
  state.fixtures = Array.from({ length: 64 }, (_, i) => ({
    id: 9000 + i, label: `Bar ${i + 1}`, profileId: bar.id, maxBrightness: 255, override: null,
    universe: Math.floor(i / perUniverse), address: 1 + (i % perUniverse) * bar.channelCount,
    position: { x: 5 + (i % 16) * 6, y: 20 + Math.floor(i / 16) * 20 },
  }));
  state.artnet.enabled = false;
  applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, masterBlackout: false, colorA: 1 });
  const read = () => Buffer.concat(universes.list().map((u) => Buffer.from(universes.getBuffer(u))));
  startEngine({ thread: 'worker' });
  try {
    const ready = Date.now() + 5000;
    while (read().filter((v) => v > 0).length < 64 && Date.now() < ready) await wait(20);
    await wait(200);
    const steady = read();
    assert.ok(steady.filter((v) => v > 0).length >= 64, 'the rig is lit');
    // Read as fast as this thread can for a second: every phase of ~44 frames.
    let reads = 0;
    let torn = 0;
    const until = performance.now() + 1000;
    while (performance.now() < until) {
      reads++;
      if (!read().equals(steady)) torn++;
    }
    assert.strictEqual(torn, 0, `${torn} of ${reads} reads caught a frame part way through`);
  } finally {
    await stopEngine();
    state.fixtures = before.fixtures;
    state.artnet.enabled = before.artnet;
    unregisterProfile(bar.id);
  }
});

test('frames keep coming while the main thread is busy', async () => {
  state.artnet.enabled = false;
  // The eight-beat breath moves the first par's 16-bit dimmer on every frame, so each frame the worker renders shows.
  applyPatch({ pattern: 'fade', running: true, masterDimmer: 255, masterBlackout: false, colorA: 1 });
  startEngine({ thread: 'worker' });
  try {
    // Stall only once the worker renders: its module compile can outlast a fixed wait.
    const ready = Date.now() + 5000;
    while (!lit() && Date.now() < ready) await wait(20);
    assert.ok(lit(), 'the worker rendered a first frame');
    // Hold the main thread for 250 ms, as a big track plan would, and watch the shared
    // buffers meanwhile, on the clock the worker's ticker keeps its deadlines on.
    const buf = universes.getBuffer(state.artnet.universe);
    const fix = state.fixtures[0];
    const ch = getProfile(fix).channelMap;
    const level = () => buf[fix.address - 1 + ch.dimmer] * 256 + (ch.dimmerFine === undefined ? 0 : buf[fix.address - 1 + ch.dimmerFine]);
    const start = hrtimeMs(), end = start + 250;
    const seen = [];
    let last = level();
    for (let t = hrtimeMs(); t < end; t = hrtimeMs()) {
      const now = level();
      if (now === last) continue;
      last = now;
      // A frame lands in a few writes; changes closer than a third of a frame are one frame.
      if (!seen.length || t - seen[seen.length - 1] > FRAME_MS / 3) seen.push(t);
    }
    const deadlines = Math.floor((end - start) / FRAME_MS);
    // The main thread posted nothing for 250 ms: every frame seen was the worker's own, from its last snapshot.
    // A starved machine may cost the worker frames; a worker that waited on this thread would show none.
    assert.ok(seen.length >= Math.min(3, deadlines), `${seen.length} frames rendered while the main thread was held (${deadlines} deadlines)`);
    // Through the whole stall, not a burst at its start: frames in both its halves.
    const mid = start + (end - start) / 2;
    assert.ok(seen.some((t) => t < mid) && seen.some((t) => t >= mid), `frames at ${seen.map((t) => Math.round(t - start))} ms into the stall`);
    // And it reports its timing once a second: poll until a report covers the stall.
    const reported = Date.now() + 5000;
    while (!(engineStatus().frames > 30) && Date.now() < reported) await wait(50);
    assert.strictEqual(engineStatus().thread, 'worker');
    assert.ok(engineStatus().frames > 30, `${engineStatus().frames} frames reported`);
  } finally {
    await stopEngine();
  }
});

test('a worker that will not start leaves the engine rendering on the main thread', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-worker-'));
  const broken = path.join(dir, 'broken-worker.js');
  fs.writeFileSync(broken, "throw new Error('no engine here');\n");
  const errors = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args) => errors.push(args.join(' '));
  console.warn = (...args) => errors.push(args.join(' '));
  state.artnet.enabled = false;
  applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, masterBlackout: false, colorA: 1 });
  try {
    startEngine({ thread: 'worker', file: broken });
    // The broken script fails when its thread loads it, and under a full
    // suite's load that exit and the first main-thread frame can take far
    // longer than any fixed wait: poll for the fallback, then judge it.
    const until = Date.now() + 5000;
    while (!(engineStatus().thread === 'main' && lit()) && Date.now() < until) await wait(20);
    const status = engineStatus();
    assert.strictEqual(status.thread, 'main');
    assert.ok(status.fellBack);
    assert.ok(lit(), 'and the rig is lit from here');
  } finally {
    await stopEngine();
    console.error = realError;
    console.warn = realWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(errors.length > 0, 'the fallback is reported');
});

// ── Idle: nothing can see the frames ─────────────────────────────────────────

/** Wait, a few milliseconds at a time, until `done()`. */
async function until(done, what, limitMs = 5000) {
  const end = Date.now() + limitMs;
  while (!done()) {
    assert.ok(Date.now() < end, `still waiting for ${what} after ${limitMs} ms`);
    await wait(5);
  }
}

const QUIET = { universes: [0], artnet: { enabled: false, host: '', port: 6454, sync: false }, sacn: { enabled: false }, delayMs: 0, armed: false };

/** A ticking engine worker fed by hand: the frames it applies and the reports it sends, as they arrive. */
async function liveWorker() {
  const w = new Worker(WORKER, { workerData: { shared: universes.allocateShared(), epochMs: hrtimeMs(), periodMs: FRAME_MS } });
  const frames = [];
  const stats = [];
  await new Promise((resolve, reject) => {
    w.on('message', (m) => {
      if (m.type === 'ready') resolve();
      if (m.type === 'frame') frames.push(m);
      if (m.type === 'stats') stats.push(m.stats);
    });
    w.once('error', reject);
  });
  const [[input]] = effectScenes(RIGS.pars, { pattern: 'solid', frames: 1 });
  let revision = 0;
  return {
    frames,
    stats,
    snapshot: (idle) => w.postMessage({ type: 'snapshot', at: hrtimeMs(), input, reading: { beatPos: 0, bpm: 120, source: 'tap', epoch: 0 },
      outputs: QUIET, barrierRevision: ++revision, outputSeq: revision, idle }),
    command: (seq) => w.postMessage({ type: 'command', seq, cmd: 'toggleDirection', intent: null }),
    close: () => w.terminate(),
  };
}

// The logger lives in the main thread: the engine asks its worker to send its console lines over instead of writing them.
test('a worker asked to sends its console lines to the main thread, with the method that wrote them', async () => {
  const lines = [];
  const w = new Worker(WORKER, { workerData: { shared: universes.allocateShared(), epochMs: hrtimeMs(), periodMs: FRAME_MS, log: true } });
  try {
    await new Promise((resolve, reject) => {
      w.on('message', (m) => { if (m.type === 'ready') resolve(); if (m.type === 'log') lines.push(m); });
      w.once('error', reject);
    });
    // Not a list of profiles: the worker's message guard reports the failure on its console.
    w.postMessage({ type: 'profiles', profiles: 7 });
    await until(() => lines.length > 0, 'the guard\'s report');
    assert.strictEqual(lines[0].method, 'error');
    assert.match(lines[0].text, /^\[engine-worker\] TypeError/);
  } finally {
    await w.terminate();
  }
});

test('an idle worker renders only for a snapshot or a command, and keeps reporting', async () => {
  const worker = await liveWorker();
  try {
    // Not idle: one snapshot, and a frame every tick from it.
    worker.snapshot(false);
    await until(() => worker.frames.length >= 10, 'ten frames from one snapshot');
    // Idle: the snapshot that says so renders once, then nothing.
    worker.snapshot(true);
    await until(() => worker.frames.at(-1).barrierRevision === 2, 'the idle snapshot rendered');
    const once = worker.frames.length;
    const reported = worker.stats.length;
    await until(() => worker.stats.length >= reported + 2, 'two reports while idle');
    assert.strictEqual(worker.frames.length, once, 'nothing rendered without a snapshot or a command');
    const [a, b] = worker.stats.slice(-2);
    assert.strictEqual(b.idle, true);
    assert.strictEqual(b.renderedTotal, once, 'every frame applied so far was counted as a render');
    assert.strictEqual(b.renderedTotal, a.renderedTotal, 'the ticker ran on, rendering nothing');
    assert.ok(b.totalFrames - a.totalFrames >= 10, `${b.totalFrames - a.totalFrames} ticks between the reports`);
    // One frame for each snapshot and each command that reaches it.
    worker.snapshot(true);
    await until(() => worker.frames.length === once + 1, 'the next idle snapshot rendered');
    worker.command(1);
    await until(() => worker.frames.length === once + 2, 'the command rendered');
    await wait(5 * FRAME_MS);
    assert.strictEqual(worker.frames.length, once + 2, 'one frame each');
    // Not idle again: every tick.
    worker.snapshot(false);
    await until(() => worker.frames.length >= once + 12, 'a frame every tick again');
  } finally {
    await worker.close();
  }
});
