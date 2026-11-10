import { parentPort, workerData } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';
import { format } from 'node:util';

import { createRenderer } from './renderer.ts';
import { allocateShared, createUniverseStore } from './universes.ts';
import { DEFAULT_WIRES, createTransmitter } from './transmit.ts';
import { createHueWire } from './hue-wire.ts';
import { createTicker, hrtimeMs, FRAME_MS } from './frame-clock.ts';
import { createClockFollower } from './clock-follow.ts';
import { getProfile, profilesRevision, registerProfile, clearNonBuiltinProfiles, BUILTIN_PROFILE_ID, HUE_COLOR_PROFILE_ID } from './profiles.ts';
import { hueProfile } from './hue-profile.ts';
import { HOLD_STROBE } from '../shared/look-math.ts';
import { guarded } from './guard.ts';
import type { MusicalTime } from './conductor.ts';
import { CONSOLE_METHODS } from './engine-messages.ts';
import type { EngineHeap, EngineWorkerData, FromWorker, RenderedFrames, ToWorker } from './engine-messages.ts';
import type { Ticker } from './frame-clock.ts';
import type { RenderInput } from './renderer.ts';
import type { SequenceTable } from '../shared/effects/sequence.ts';
import type { TransmitConfig } from './transmit.ts';
import type { Point, Profile } from '../types/rig.ts';

if (!parentPort) throw new Error('engine-worker.ts runs as a worker thread');
const port = parentPort;

const post = (msg: FromWorker) => port.postMessage(msg);

const {
  shared, epochMs, periodMs = FRAME_MS, capture = false, seed = null, startNow = null, retire = null, hueReclaim = false,
  log = false,
} = (workerData || {}) as EngineWorkerData;

// The logger lives in the main thread (one log file, one in-app log). Written from here, this thread's lines (every
// output's warnings) reached the terminal as bare text, without level or component, and missed both.
if (log) for (const method of CONSOLE_METHODS) console[method] = (...args: unknown[]) => post({ type: 'log', method, text: format(...args) });

function seeded(value: number): () => number {
  let a = value >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
if (capture && Number.isInteger(seed)) Math.random = seeded(seed as number);

const store = createUniverseStore();               // rendered into, this thread only
const published = createUniverseStore(shared);     // what the main thread reads
// Hue leaves with the rest of the frame from here; the main thread only hears how each bridge is doing.
const hueWire = createHueWire({ onStatus: (status) => post({ type: 'hue', status }), reclaim: hueReclaim });
const transmitter = createTransmitter({ wires: { ...DEFAULT_WIRES, ...hueWire.wires } });
// A previous sender's unfinished retirement comes first: nothing lights until those routes are dark.
const inherited = !!retire?.length;
if (retire?.length) transmitter.seed(retire);
const renderer = createRenderer({
  profileOf: getProfile,
  profilesRevision,
  now: typeof startNow === 'number' && Number.isFinite(startNow) ? startNow : hrtimeMs(),
});
const follow = createClockFollower();

// Warm effects on private buffers so first-use compilation cannot overrun a live frame.
function warmUp(): void {
  const scratch = createUniverseStore(allocateShared());
  const bulb = hueProfile({ id: 'warmup-bulb', name: 'Bulb', product: 'Hue lamp', devices: [], channels: [0], kind: 'color',
    capabilities: { gamut: 'C', whites: { warm: 2000, cool: 6536 }, fixedWhite: null } })!;
  const strip = hueProfile({ id: 'warmup-strip', name: 'Strip', product: 'Hue gradient', devices: [], channels: [1, 2, 3], kind: 'color',
    capabilities: { gamut: 'C', whites: { warm: 2000, cool: 6536 }, fixedWhite: null } })!;
  const profiles = new Map([[bulb.id, bulb], [strip.id, strip]]);
  const warm = createRenderer({ profileOf: (fixture) => profiles.get(fixture.profileId) || getProfile(fixture), profilesRevision, now: 0 });
  const par = (id: number) => ({ id, address: 1 + 12 * id, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null,
    position: { x: 20 + 20 * id, y: 40 }, group: null, geometry: null, hue: false });
  const fixtures = [par(0), par(1), { ...par(2), profileId: HUE_COLOR_PROFILE_ID, hue: true },
    { ...par(3), profileId: bulb.id, hue: true }, { ...par(4), profileId: strip.id, hue: true }];
  const look: RenderInput = {
    running: true, pattern: 'chase', colorA: 0, colorB: 5, colorC: 3, colorD: 8, split: null, pixelMap: 'stage', beatDivision: 1,
    strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null,
    patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures, safety: { hdFlashIntervalMs: 350, acknowledged: true },
  };
  let now = 0;
  for (const energy of [null, 'blinder', HOLD_STROBE, 'white-strobe']) {
    for (const hueStrobe of ['flash', 'pulse'] as const) {
      for (let k = 0; k < 2; k++) {
        warm.frame({ ...look, energy, hueStrobe }, { beatPos: now / 500, bpm: 120, source: 'tap', epoch: 0 }, now, scratch, 0);
        now += FRAME_MS;
      }
    }
  }
}

let snapshot: { input: RenderInput; outputs: TransmitConfig; barrierRevision: number; outputSeq: number; idle: boolean } | null = null;
let points: (Point[] | null)[] = [];               // each fixture's mapped points, by its place in the snapshots

/** Each fixture's mapped points, held here rather than cloned into every snapshot; a fixture that brings its own keeps them. */
function withPoints(input: RenderInput): RenderInput {
  const { fixtures } = input;
  for (let i = 0; i < fixtures.length; i++) {
    const held = points[i], geometry = fixtures[i].geometry;
    if (held && geometry && !geometry.points) geometry.points = held;
  }
  return input;
}
let fresh = false;                                 // a snapshot or command arrived since the last render
let pendingSequence: { table: SequenceTable | null } | null = null;

function takeSequence(): void {
  if (!pendingSequence) return;
  renderer.setSequence(pendingSequence.table);
  pendingSequence = null;
}

let lastStatsAt = -Infinity;

function heap(): EngineHeap {
  const { used_heap_size: usedBytes, total_heap_size: totalBytes } = getHeapStatistics();
  return { usedBytes, totalBytes };
}

function setProfiles(profiles: Profile[] | null | undefined): void {
  clearNonBuiltinProfiles();
  for (const profile of profiles || []) registerProfile(profile);
}

function publish(): void {
  const live = store.list();
  published.sync(live);
  for (const universe of live) published.getBuffer(universe).set(store.getBuffer(universe));
  published.drainRetired();
}

function transmit(outputs: TransmitConfig): boolean {
  const protective = snapshot?.input.masterBlackout || !outputs.armed;
  for (const universe of store.list()) transmitter.send(universe, store.getBuffer(universe), outputs,
    protective ? { immediate: true, terminate: true } : undefined);
  for (const [universe, frame] of store.drainRetired()) {
    transmitter.send(universe, frame, outputs, { immediate: true, terminate: true });
  }
  return transmitter.endFrame(outputs);
}

let ticker: Ticker | null = null;

function postCommands(): void {
  const results = renderer.takeCommandResults();
  if (!results.length) return;
  const { processed, applied } = renderer.commandStatus();
  post({ type: 'commands', results, processed, applied });
}

function renderTick(due: number, now: number): void {
  if (now - lastStatsAt >= 1000) {
    lastStatsAt = now;
    if (ticker) post({ type: 'stats', stats: ticker.stats.summary(), heap: heap() });
  }
  // Idle effects step about 0.2 s per render (effDt is unclamped, beats capped at 4): nobody can see it.
  if (snapshot?.idle && !fresh) return;
  const reading = snapshot ? follow.at(now) : null;
  if (!snapshot || !reading) {
    renderer.rejectCommands('unavailable');
    postCommands();
    return;
  }
  fresh = false;
  renderer.frame(snapshot.input, reading, now, store, epochMs);
  ticker?.stats.rendered();
  postCommands();
  const applied = transmit(snapshot.outputs);
  publish();
  const { barrierRevision, outputSeq } = snapshot;
  if (applied) post({ type: 'frame', barrierRevision, outputSeq });
}

/** Darken everything; whether every destination, inherited ones included, was actually retired. */
function blackout(): boolean {
  let applied = !inherited;
  if (snapshot) {
    store.sync(snapshot.input.universes);
    store.clearAll();
    const outputs = snapshot.outputs;
    for (const universe of store.list()) {
      transmitter.send(universe, store.getBuffer(universe), outputs, { immediate: true, terminate: true });
    }
    for (const [universe, frame] of store.drainRetired()) {
      transmitter.send(universe, frame, outputs, { immediate: true, terminate: true });
    }
    applied = transmitter.endFrame(outputs);
  } else {
    store.clearAll();
  }
  publish();
  return applied;
}

function renderOnce({ input, reading, now, gridOriginMs }: { input: RenderInput; reading: MusicalTime; now: number; gridOriginMs?: number }): RenderedFrames {
  renderer.frame(input, reading, now, store, gridOriginMs);
  const frames: RenderedFrames = {};
  for (const universe of store.list()) frames[universe] = Array.from(store.getBuffer(universe));
  for (const [universe] of store.drainRetired()) frames[universe] = null;
  return frames;
}

port.on('message', guarded('engine-worker', (msg: ToWorker | null) => {
  if (!msg) return;
  switch (msg.type) {
    case 'profiles':
      setProfiles(msg.profiles);
      break;
    case 'space':
      renderer.setSpace(msg.space);
      break;
    case 'points':
      points = msg.points;
      break;
    case 'snapshot':
      takeSequence();
      snapshot = { input: withPoints(msg.input), outputs: msg.outputs, barrierRevision: msg.barrierRevision ?? 0, outputSeq: msg.outputSeq ?? 0,
        idle: msg.idle === true };
      follow.push(msg.reading, msg.at);
      fresh = true;
      if (ticker) ticker.stats.idle = snapshot.idle;
      break;
    case 'sequence':
      pendingSequence = { table: msg.table ?? null };
      break;
    case 'render': {
      takeSequence();
      if (msg.table !== undefined) renderer.setSequence(msg.table);
      const frames = renderOnce({ ...msg, input: withPoints(msg.input) });
      const commands = renderer.takeCommandResults();
      post({ type: 'rendered', id: msg.id, frames, ...(commands.length ? { commands } : {}) });
      break;
    }
    case 'command':
      renderer.command(msg.seq, msg.cmd, msg.arg, msg.intent ?? null);
      fresh = true;
      break;
    case 'stop': {
      if (ticker) ticker.stop();
      const applied = blackout();
      // Stopped only once every Hue bridge had its dark frame and its session was released, or that failed.
      void hueWire.closeAll().then((hue) => post({ type: 'stopped', applied, hue }));
      break;
    }
    default:
      break;
  }
}));

if (!capture) {
  try { warmUp(); } catch { /* nothing to undo: it touched only its own renderer */ }
  ticker = createTicker({ onTick: guarded('render', renderTick), periodMs, epochMs });
  ticker.start();
}
post({ type: 'ready' });
