import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { state, universeOf } from '../../src/server/state.ts';
import * as universes from '../../src/server/universes.ts';
import { startEngine, stopEngine, resizeFixtureBuffers, startSyncTest, setIdleSource, engineStatus, effectCommand,
  awaitFrameApplied, IDLE_EVERY } from '../../src/server/engine.ts';
import { FRAME_MS as TICK_MS, hrtimeMs } from '../../src/server/frame-clock.ts';
import * as output from '../../src/server/output.ts';
import { conductor } from '../../src/server/conductor.ts';
import { applyPatch, applyOverride, setFixtureMaxBrightness } from '../../src/server/patch.ts';
import { PATTERN_FUNCS } from '../../src/shared/patterns.ts';

// renderDmx isn't exported — it runs on the engine's own 25 ms interval, so the
// tests drive it by starting the engine and waiting for a frame.
const FRAME_MS = 25;
const frames = (n = 2) => new Promise((r) => setTimeout(r, FRAME_MS * n + 20));

/** The universe-0 buffer, which is what the default patch renders into. */
const dmx = () => universes.getBuffer(state.artnet.universe);

/** The DMX slice a fixture at `address` with `count` channels occupies. */
function channels(address, count, universe = state.artnet.universe) {
  const buf = universes.getBuffer(universe);
  return Array.from(buf.subarray(address - 1, address - 1 + count));
}

const anyLit = (vals) => vals.some((v) => v !== 0);

test.before(() => {
  state.artnet.enabled = false;
  applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, colorA: 1, masterBlackout: false });
  startEngine();
});

test.after(() => stopEngine());

test('a deleted fixture stops being driven instead of latching its last look', async () => {
  applyPatch({ masterBlackout: false });
  conductor.tap();
  await frames();

  const doomed = state.fixtures[state.fixtures.length - 1];
  const { address } = doomed;
  assert.ok(anyLit(channels(address, 12)), 'fixture should be lit before removal');

  // Exactly what DELETE /api/fixtures/:id does.
  state.fixtures = state.fixtures.filter((f) => f.id !== doomed.id);
  resizeFixtureBuffers();
  await frames();

  // Art-Net receivers latch the last frame, so a non-zero value here is a
  // fixture stuck on for the rest of the show with no way to clear it.
  assert.deepStrictEqual(
    channels(address, 12), new Array(12).fill(0),
    'channels of a removed fixture must be cleared, not left latched',
  );
});

test('re-addressing a fixture clears the channels it moved away from', async () => {
  const fix = state.fixtures[0];
  const from = fix.address;
  applyPatch({ masterBlackout: false });
  conductor.tap();
  await frames();
  assert.ok(anyLit(channels(from, 12)), 'fixture should be lit at its original address');

  const to = 200;
  fix.address = to;
  await frames();

  assert.deepStrictEqual(
    channels(from, 12), new Array(12).fill(0),
    'the vacated channels must go dark',
  );
  assert.ok(anyLit(channels(to, 12)), 'the fixture should now be driven at its new address');

  fix.address = from;
});

test('master blackout clears the whole universe, not just patched channels', async () => {
  applyPatch({ masterBlackout: false });
  conductor.tap();
  await frames();

  // Strand a value outside every fixture's footprint, as a removed or
  // re-addressed fixture used to.
  dmx()[400] = 255;

  applyPatch({ masterBlackout: true });
  await frames();

  assert.deepStrictEqual(
    Array.from(dmx()), new Array(512).fill(0),
    'blackout must mean every channel at zero',
  );
  applyPatch({ masterBlackout: false });
});

// Before universes, every fixture shared one 512-byte buffer, so address 1 on
// two different nodes was the same wire. It is not.
test('a fixture on another universe writes into that universe, not universe 0', async () => {
  const fix = state.fixtures[0];
  const home = universeOf(fix);
  const away = home + 3;
  const { address } = fix;

  applyPatch({ masterBlackout: false });
  conductor.tap();
  await frames();
  assert.ok(anyLit(channels(address, 12, home)), 'fixture is lit on its own universe first');

  fix.universe = away;
  await frames();

  assert.ok(anyLit(channels(address, 12, away)), 'the fixture drives its new universe');
  assert.deepStrictEqual(
    channels(address, 12, home), new Array(12).fill(0),
    'and the universe it left goes dark rather than latching',
  );

  fix.universe = home;
  await frames();
});

// A universe nobody is patched on any more must be blacked out once and then
// dropped, or its node holds the last look it was sent for the rest of the set.
test('a universe that leaves the patch is retired with a final blackout frame', async () => {
  const fix = state.fixtures[0];
  const home = universeOf(fix);
  const away = home + 11;

  fix.universe = away;
  await frames();
  assert.ok(universes.list().includes(away), 'the universe is transmitted while in use');

  fix.universe = home;
  await frames(3);
  assert.ok(!universes.list().includes(away), 'and is dropped once nothing is patched on it');
});

test('stopEngine leaves the rig dark rather than holding the last look', async () => {
  applyPatch({ masterBlackout: false });
  conductor.tap();
  startEngine();
  await frames();
  assert.ok(anyLit(Array.from(dmx())), 'something should be lit before shutdown');

  stopEngine();
  for (const universe of universes.list()) {
    assert.deepStrictEqual(
      Array.from(universes.getBuffer(universe)), new Array(512).fill(0),
      `shutdown must black out universe ${universe}`,
    );
  }

  startEngine();   // restore for any later test
});

// ── Brightness ceilings ─────────────────────────────────────────────────────
// Two of them sit above whatever is driving a fixture: the grand master, and
// the fixture's own trim. Both used to be bypassed by an energy override, which
// meant the blinder came up at full no matter where the master sat.

/** The dimmer channel of `fix`, which is offset 0 in the built-in profile. */
const dimmerOf = (fix) => universes.getBuffer(universeOf(fix))[fix.address - 1];

/** The red channel, which carries the master + trim scaling as well. */
const redOf = (fix) => universes.getBuffer(universeOf(fix))[fix.address - 1 + 3];

test('a fixture max brightness trims its output without overriding it', async () => {
  const fix = state.fixtures[0];
  applyPatch({ pattern: 'solid', colorA: 9, masterDimmer: 255, masterBlackout: false });
  conductor.tap();
  await frames();

  const full = dimmerOf(fix);
  assert.ok(full > 0, 'the fixture should be lit at no trim');

  try {
    setFixtureMaxBrightness(fix.id, 128);
    await frames();

    assert.strictEqual(fix.override, null, 'trimming must not put the fixture into override mode');
    const trimmed = dimmerOf(fix);
    assert.ok(trimmed < full, `trim should pull the dimmer down (${trimmed} < ${full})`);
    assert.ok(Math.abs(trimmed - Math.round(full * (128 / 255))) <= 1, 'and by the ratio it was set to');

    // The neighbour is untouched: this is a per-fixture ceiling, not a master.
    assert.strictEqual(dimmerOf(state.fixtures[1]), full, 'other fixtures keep their level');
  } finally {
    setFixtureMaxBrightness(fix.id, 255);
  }
});

test('a fixture max brightness of 0 puts that fixture out', async () => {
  const fix = state.fixtures[0];
  applyPatch({ pattern: 'solid', colorA: 9, masterDimmer: 255, masterBlackout: false });
  conductor.tap();
  await frames();

  try {
    setFixtureMaxBrightness(fix.id, 0);
    await frames();
    assert.deepStrictEqual(
      channels(fix.address, 12), new Array(12).fill(0),
      'a fixture trimmed to zero must output nothing at all',
    );
  } finally {
    setFixtureMaxBrightness(fix.id, 255);
  }
});

test('an energy override follows the grand master', async () => {
  const fix = state.fixtures[0];
  applyPatch({ masterBlackout: false, masterDimmer: 255, energyOverride: 'blinder' });
  await frames();
  const atFull = redOf(fix);
  assert.ok(atFull > 200, 'the blinder should be near full with the master up');

  try {
    applyPatch({ masterDimmer: 64 });
    await frames();
    const atQuarter = redOf(fix);
    assert.ok(
      atQuarter < atFull / 2,
      `an energy override must follow the master (${atQuarter} vs ${atFull})`,
    );
    assert.ok(Math.abs(atQuarter - Math.round(255 * (64 / 255))) <= 2, 'and scale by it');
  } finally {
    applyPatch({ energyOverride: null, masterDimmer: 255 });
  }
});

test('an energy override follows a fixture max brightness', async () => {
  const trimmed = state.fixtures[0];
  const untouched = state.fixtures[1];
  applyPatch({ masterBlackout: false, masterDimmer: 255, energyOverride: 'blinder' });
  await frames();

  try {
    setFixtureMaxBrightness(trimmed.id, 100);
    await frames();

    assert.ok(
      redOf(trimmed) < redOf(untouched),
      'the trimmed fixture must come up lower than its untrimmed neighbour',
    );
    assert.ok(redOf(untouched) > 200, 'and the neighbour still blinds');
  } finally {
    setFixtureMaxBrightness(trimmed.id, 255);
    applyPatch({ energyOverride: null });
  }
});

// A trim scales, it does not clip. Under a clamping implementation a fixture
// already sitting below the trim would come out untouched — the level would
// only bend once it crossed the line, so the bottom of every fader throw would
// feel dead and two fixtures at different trims would converge as they dimmed.
// Scaling keeps the whole range proportional: half the trim is half the output
// at every level, not only at the top.
test('a fixture max brightness scales the whole range rather than clipping it', async () => {
  const fix = state.fixtures[0];
  applyPatch({ masterBlackout: false, masterDimmer: 255 });

  try {
    // Well under the trim: a clamp would leave this at 100 and only bite above 128.
    applyOverride(fix.id, { enabled: true, r: 200, g: 0, b: 0, w: 0, dim: 100, strobe: 0 });
    setFixtureMaxBrightness(fix.id, 255);
    await frames();
    assert.strictEqual(dimmerOf(fix), 100, 'untrimmed, the override level passes through');
    assert.strictEqual(redOf(fix), Math.round(200 * (100 / 255)));

    setFixtureMaxBrightness(fix.id, 128);
    await frames();
    assert.strictEqual(
      dimmerOf(fix), Math.round(100 * (128 / 255)),
      'a level below the trim must still be scaled by it, not passed through',
    );
    assert.strictEqual(
      redOf(fix), Math.round(200 * (100 / 255) * (128 / 255)),
      'and the colour channels scale with it',
    );
  } finally {
    applyOverride(fix.id, null);
    setFixtureMaxBrightness(fix.id, 255);
  }
});

// The same rule for the grand master, which is the trim's sibling: two fixtures
// trimmed differently must stay in proportion as the master comes down, rather
// than meeting at the bottom.
test('trims stay in proportion to each other as the master falls', async () => {
  const half = state.fixtures[0];
  const full = state.fixtures[1];
  applyPatch({ pattern: 'solid', colorA: 9, masterDimmer: 255, masterBlackout: false });
  conductor.tap();

  try {
    setFixtureMaxBrightness(half.id, 128);
    await frames();
    const ratioAtFull = dimmerOf(half) / dimmerOf(full);

    applyPatch({ masterDimmer: 64 });
    await frames();
    const ratioAtQuarter = dimmerOf(half) / dimmerOf(full);

    assert.ok(
      Math.abs(ratioAtFull - ratioAtQuarter) < 0.05,
      `the two fixtures keep their ratio (${ratioAtFull} vs ${ratioAtQuarter})`,
    );
  } finally {
    setFixtureMaxBrightness(half.id, 255);
    applyPatch({ masterDimmer: 255 });
  }
});

// A fixture the operator has pinned is spared the music's level — that is what
// pinning it is for. The silence rule below it then zeroed every fixture that
// was not in an energy burst, pinned or not, so a pinned lamp dropped out on
// every quiet passage in the track and came back when the music did.
test('a pinned fixture stays lit through a silence', async () => {
  const pinned = state.fixtures[0];
  const free = state.fixtures[1];
  applyPatch({ pattern: 'solid', colorA: 9, masterDimmer: 255, masterBlackout: false });
  conductor.tap();

  try {
    applyOverride(pinned.id, { enabled: true, r: 200, g: 0, b: 0, w: 0, dim: 255, strobe: 0 });
    applyPatch({ showDynamics: { level: 0, motion: 0, width: 0.5, air: 0.5 } });
    await frames(4);

    assert.strictEqual(dimmerOf(free), 0, 'the music-driven fixture goes dark in the silence');
    assert.strictEqual(dimmerOf(pinned), 255, 'the pinned fixture holds its level');
    assert.strictEqual(redOf(pinned), 200, 'and its colour');
  } finally {
    applyOverride(pinned.id, null);
    applyPatch({ showDynamics: null });
  }
});

// The pattern clock keeps time against the music, not against its own last
// tick. The old beat timer scheduled each step a period after the previous one
// ran, so under load every late step delayed all the ones after it and a
// tapped tempo fell steadily behind the song. Steps are now read off the
// musical clock, so a busy event loop can make a frame late but can never make
// the count fall behind: the gap between elapsed time and steps taken stays
// inside one step for the whole run instead of growing.
test('the pattern clock does not fall behind under load', async () => {
  const chase = PATTERN_FUNCS.chase;
  const seen = [];
  PATTERN_FUNCS.chase = (ctx) => { seen.push({ t: performance.now(), step: ctx.step }); return chase(ctx); };
  // A busy event loop, as the render loop and a socket burst make it.
  const hog = setInterval(() => { const until = performance.now() + 7; while (performance.now() < until); }, 13);
  try {
    applyPatch({ bpm: 300, beatDivision: 4, pattern: 'chase', running: true });
    await new Promise((r) => setTimeout(r, 2000));
    assert.ok(seen.length > 20, `only ${seen.length} frames rendered`);
    const perMs = (300 / 60000) * 4;
    const residual = seen.map((x) => (x.t - seen[0].t) * perMs - (x.step - seen[0].step));
    const spread = Math.max(...residual) - Math.min(...residual);
    assert.ok(spread < 1.5, `the step count strayed ${spread.toFixed(2)} steps from elapsed time over ${seen.length} frames`);
    assert.ok(seen[seen.length - 1].step - seen[0].step >= 30, 'and it kept stepping');
  } finally {
    clearInterval(hog);
    PATTERN_FUNCS.chase = chase;
    applyPatch({ bpm: 120, beatDivision: 1, pattern: 'solid' });
  }
});

// The Hue sync test: every fixture white for the first tenth of each second,
// dark for the rest, then the show comes back.
test('the sync test flashes the whole rig once a second, then hands it back', async () => {
  applyPatch({ pattern: 'solid', colorA: 1, masterDimmer: 255, masterBlackout: false });
  conductor.tap();
  await frames();
  const before = channels(state.fixtures[0].address, 12);

  startSyncTest(0.4);
  await frames(1);
  for (const fix of state.fixtures) {
    assert.strictEqual(dimmerOf(fix), 255, `${fix.label} flashes`);
    assert.strictEqual(redOf(fix), 255, `${fix.label} flashes white`);
  }
  await new Promise((r) => setTimeout(r, 150));
  for (const fix of state.fixtures) assert.strictEqual(dimmerOf(fix), 0, `${fix.label} is dark between flashes`);

  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(channels(state.fixtures[0].address, 12), before, 'the look comes back when it ends');
});

// ── Crossfades ───────────────────────────────────────────────────────────────

/** Red and blue of a fixture, at the built-in profile's offsets. */
const rgbOf = (fix) => {
  const buf = universes.getBuffer(universeOf(fix));
  return { r: buf[fix.address - 1 + 3], b: buf[fix.address - 1 + 5] };
};

test('a look that asks for a fade blends into place instead of cutting', async () => {
  const fix = state.fixtures[0];
  applyPatch({ pattern: 'solid', colorA: 0, masterDimmer: 255, masterBlackout: false, showDynamics: null });
  conductor.tap();
  await frames(3);
  assert.deepStrictEqual(rgbOf(fix), { r: 255, b: 0 }, 'red to begin with');

  applyPatch({ colorA: 5, fadeMs: 400 });
  conductor.tap();
  await new Promise((r) => setTimeout(r, 200));
  const mid = rgbOf(fix);
  assert.ok(mid.r > 0 && mid.b > 0, `halfway it is both: ${JSON.stringify(mid)}`);

  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(rgbOf(fix), { r: 0, b: 255 }, 'and blue once the fade is done');
});

test('a look without a fade cuts, even in the middle of one', async () => {
  const fix = state.fixtures[0];
  applyPatch({ pattern: 'solid', colorA: 0, showDynamics: null });
  conductor.tap();
  await frames(3);
  applyPatch({ colorA: 5, fadeMs: 2000 });
  conductor.tap();
  await frames(2);
  // A drop lands on the downbeat, not two seconds later.
  applyPatch({ colorA: 3 });
  conductor.tap();
  await frames(2);
  const buf = universes.getBuffer(universeOf(fix));
  assert.deepStrictEqual([buf[fix.address + 2], buf[fix.address + 3], buf[fix.address + 4]], [0, 255, 85], 'straight to green');
});

// ── Split looks ──────────────────────────────────────────────────────────────
test('a split look holds one group on colour B while the rest run the pattern', async () => {
  const [a, b, c] = state.fixtures;
  try {
    a.group = 'front'; b.group = 'back';
    applyPatch({ pattern: 'solid', colorA: 0, colorB: 5, showDynamics: null, split: 1 });
    conductor.tap();
    await frames(3);
    assert.deepStrictEqual(rgbOf(a), { r: 255, b: 0 }, 'front runs the pattern in A');
    assert.deepStrictEqual(rgbOf(b), { r: 0, b: 255 }, 'back holds the wash in B');
    assert.deepStrictEqual(rgbOf(c), { r: 255, b: 0 }, 'ungrouped runs the pattern');

    applyPatch({ split: null });
    conductor.tap();
    await frames(3);
    assert.deepStrictEqual(rgbOf(b), { r: 255, b: 0 }, 'unsplit, the whole rig is the pattern');
  } finally {
    for (const f of state.fixtures) delete f.group;
    applyPatch({ split: null });
  }
});

test('a split with only one group in use leaves the look whole', async () => {
  const [a] = state.fixtures;
  try {
    a.group = 'front';
    applyPatch({ pattern: 'solid', colorA: 0, colorB: 5, showDynamics: null, split: 0 });
    conductor.tap();
    await frames(3);
    for (const f of state.fixtures) assert.deepStrictEqual(rgbOf(f), { r: 255, b: 0 }, f.label);
  } finally {
    delete a.group;
    applyPatch({ split: null });
  }
});

// ── Idle: nothing can see the frames ─────────────────────────────────────────
// While its idle source says nothing can see a frame and nothing waits on one,
// the engine renders a ninth of its ticks; whatever waits makes it render at once.

/** Wait, a few milliseconds at a time, until `done()`. */
async function until(done, what, limitMs = 5000) {
  const end = Date.now() + limitMs;
  while (!done()) {
    assert.ok(Date.now() < end, `still waiting for ${what} after ${limitMs} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const counts = () => { const s = engineStatus(); return { ticks: s.totalFrames, rendered: s.renderedTotal }; };

test('idle on the main thread: a ninth of the ticks render, and a command does not wait for one', async () => {
  setIdleSource(() => true);
  try {
    assert.strictEqual(engineStatus().idle, true);
    const from = counts();
    await until(() => counts().ticks >= from.ticks + 4 * IDLE_EVERY, 'four idle cycles');
    const to = counts();
    const ticks = to.ticks - from.ticks;
    const rendered = to.rendered - from.rendered;
    assert.ok(Math.abs(rendered - ticks / IDLE_EVERY) <= 1, `${rendered} of ${ticks} ticks rendered`);
    // Sent just after an idle render, a command is decided on the next tick, not at the next render due.
    const last = counts().rendered;
    await until(() => counts().rendered > last, 'an idle render');
    const sent = counts();
    await effectCommand('toggleDirection');
    const decided = counts();
    assert.ok(decided.ticks - sent.ticks <= 2, `decided ${decided.ticks - sent.ticks} ticks after it was sent`);
    assert.ok(decided.rendered > sent.rendered, 'by a frame rendered for it');
  } finally {
    setIdleSource(null);
  }
  assert.strictEqual(engineStatus().idle, false);
  const from = counts();
  await until(() => counts().ticks >= from.ticks + IDLE_EVERY, 'a cycle');
  const to = counts();
  assert.strictEqual(to.rendered - from.rendered, to.ticks - from.ticks, 'not idle: every tick renders');
});

// A stand-in engine worker that logs every snapshot and command it is sent and reports the log in its
// stats. It acknowledges as the real one does when it applies a frame, except: a new barrier revision and
// a command only after HOLD_MS, and Art-Net routes only from a snapshot whose outputs are disarmed.
const HOLD_MS = 300;
const RECORDING_WORKER = `
import { parentPort } from 'node:worker_threads';
const log = [];
let acked = null;
let holding = false;
parentPort.on('message', (msg) => {
  if (msg.type === 'snapshot') {
    log.push({ at: msg.at, idle: msg.idle === true, revision: msg.barrierRevision });
    const outputSeq = msg.outputs.armed === false ? msg.outputSeq : undefined;
    if (acked === null) acked = msg.barrierRevision;
    if (msg.barrierRevision === acked) parentPort.postMessage({ type: 'frame', barrierRevision: acked, outputSeq });
    else if (!holding) {
      holding = true;
      setTimeout(() => {
        holding = false;
        acked = msg.barrierRevision;
        parentPort.postMessage({ type: 'frame', barrierRevision: acked, outputSeq });
      }, ${HOLD_MS});
    }
  }
  if (msg.type === 'command') {
    log.push({ command: msg.seq });
    setTimeout(() => parentPort.postMessage({ type: 'commands', results: [{ seq: msg.seq, status: 'applied' }], processed: msg.seq, applied: msg.seq }), ${HOLD_MS});
  }
  if (msg.type === 'stop') parentPort.postMessage({ type: 'stopped', applied: true });
  parentPort.postMessage({ type: 'stats', stats: { log } });
});
parentPort.postMessage({ type: 'ready' });
`;

/** The engine on the recording worker, idle by its source, for the length of `fn`; this file's main-thread engine after. */
async function onRecordingWorker(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-idle-worker-'));
  const file = path.join(dir, 'recording-worker.mjs');
  fs.writeFileSync(file, RECORDING_WORKER);
  await stopEngine();
  setIdleSource(() => true);
  startEngine({ thread: 'worker', file });
  try {
    await fn(() => (engineStatus().log ?? []));
  } finally {
    await stopEngine();
    setIdleSource(null);
    fs.rmSync(dir, { recursive: true, force: true });
    startEngine();
  }
}

const snapshots = (entries) => entries.filter((e) => e.at !== undefined);
const gapsOf = (entries) => { const s = snapshots(entries); return s.slice(1).map((e, i) => e.at - s[i].at); };
const shown = (gaps) => gaps.map((g) => Math.round(g)).join(', ');
const between = (entries, from, to = Infinity) => snapshots(entries).filter((e) => e.at >= from && e.at <= to);

test('idle with a worker: a snapshot every ninth tick, flagged idle; a change awaiting acknowledgement, every tick', async () => {
  await onRecordingWorker(async (log) => {
    await until(() => snapshots(log()).length >= 4, 'four idle snapshots');
    assert.ok(snapshots(log()).every((e) => e.idle), 'each flagged idle');
    assert.ok(Math.min(...gapsOf(log())) > 6 * TICK_MS, `idle snapshots ${shown(gapsOf(log()))} ms apart`);

    const calledAt = hrtimeMs();
    await awaitFrameApplied();
    const ackedAt = hrtimeMs();
    const held = between(log(), calledAt, ackedAt);
    assert.ok(held[0].at - calledAt < TICK_MS, 'the change is posted at once, not at the next idle tick');
    assert.ok(held.length >= 3, `${held.length} snapshots while the change awaited acknowledgement`);
    assert.ok(held.every((e) => !e.idle), 'none of them idle');
    assert.ok(Math.min(...gapsOf(held)) < 3 * TICK_MS, `posted ${shown(gapsOf(held))} ms apart`);

    await until(() => between(log(), ackedAt).length >= 3, 'snapshots once acknowledged');
    const after = between(log(), ackedAt);
    assert.ok(after.every((e) => e.idle), 'idle again once acknowledged');
    assert.ok(Math.min(...gapsOf(after)) > 6 * TICK_MS, `idle snapshots ${shown(gapsOf(after))} ms apart`);
  });
});

test('idle with a worker: Art-Net routes awaiting acknowledgement keep the snapshots coming every tick', async () => {
  const enabled = state.artnet.enabled;
  await onRecordingWorker(async (log) => {
    await until(() => snapshots(log()).length >= 2, 'idle snapshots');
    const armedAt = hrtimeMs();
    state.artnet.enabled = true;
    output.setArmed(true);
    let disarmedAt;
    try {
      await until(() => between(log(), armedAt).length >= 6, 'snapshots while routes are outstanding');
    } finally {
      output.setArmed(false);
      state.artnet.enabled = enabled;
      disarmedAt = hrtimeMs();
    }
    // The first snapshot armed is still idle: it issues the routes, which then await acknowledgement.
    const armed = between(log(), armedAt, disarmedAt).slice(1);
    assert.ok(armed.every((e) => !e.idle), 'an unacknowledged route ends idle');
    assert.ok(Math.min(...gapsOf(armed)) < 3 * TICK_MS, `posted ${shown(gapsOf(armed))} ms apart`);
    // Disarmed, the worker acknowledges the routes: idle again.
    await until(() => between(log(), disarmedAt).filter((e) => e.idle).length >= 3, 'idle once the routes are retired');
  });
});

test('idle with a worker: a command goes at once with its snapshot, and every tick follows until it is answered', async () => {
  await onRecordingWorker(async (log) => {
    await until(() => snapshots(log()).length >= 2, 'idle snapshots');
    const result = await effectCommand('toggleDirection');
    const answeredAt = hrtimeMs();
    assert.strictEqual(result.status, 'applied');
    const entries = log();
    const at = entries.findIndex((e) => e.command === result.seq);
    assert.ok(at >= 1 && entries[at - 1].at !== undefined && !entries[at - 1].idle, 'its snapshot right before it, not idle');
    const waiting = between(entries.slice(at), 0, answeredAt);
    assert.ok(waiting.length >= 2 && waiting.every((e) => !e.idle), `${waiting.length} snapshots, none idle, while it was answered`);
    assert.ok(Math.min(...gapsOf(waiting)) < 3 * TICK_MS, `posted ${shown(gapsOf(waiting))} ms apart`);
  });
});
